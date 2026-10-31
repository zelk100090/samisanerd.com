'use strict';
// Drift Lists server: serves the app behind a password, stores lists, and
// pushes "something changed" to every open device. Run: node server.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');
const store = require('./store');

/* ---------- config (environment variables) ---------- */
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';                 // keep local; put HTTPS proxy in front
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`).replace(/\/$/, '');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';           // read client IP from X-Forwarded-For
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const SECURE_COOKIE = PUBLIC_ORIGIN.startsWith('https://');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!auth.init(DATA_DIR)) {
  console.error(`No password set. Run:  node set-password.js${process.env.DATA_DIR ? ' --data "' + DATA_DIR + '"' : ''}`);
  process.exit(1);
}
store.init(DATA_DIR);

/* ---------- files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const PUBLIC_FILES = { '/login': 'login.html', '/login.js': 'login.js', '/icon.png': 'icon.png',
                       '/manifest.webmanifest': 'manifest.webmanifest' };
const PRIVATE_FILES = { '/': 'app.html', '/app.js': 'app.js' };

const CSP = [
  "default-src 'self'", "script-src 'self'", "connect-src 'self'", "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
  "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
  ...(SECURE_COOKIE ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
};

function sendFile(res, name) {
  const body = fs.readFileSync(path.join(PUBLIC_DIR, name));
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream' });
  res.end(body);
}
function sendJson(res, status, obj) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function redirect(res, to) { res.writeHead(303, { ...SECURITY_HEADERS, Location: to }); res.end(); }

function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413, expose: true })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('Body must be JSON'), { status: 400, expose: true })); }
    });
    req.on('error', reject);
  });
}

// Blocks other websites from submitting requests with your cookie (CSRF).
function sameOrigin(req) {
  if (req.headers.origin) return req.headers.origin === PUBLIC_ORIGIN;
  return req.headers['sec-fetch-site'] === 'same-origin';
}
function clientIp(req) {
  // Use the LAST entry: that's the one your proxy added. Earlier ones come from the visitor and can be faked.
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',').pop().trim();
  return req.socket.remoteAddress || 'unknown';
}

/* ---------- live updates (Server-Sent Events) ---------- */
const streams = new Set();
function openStream(req, res) {
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive',
                       'X-Accel-Buffering': 'no' }); // tells nginx not to buffer the stream
  res.write(`retry: 3000\nevent: rev\ndata: ${store.rev()}\n\n`);
  streams.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(ping); streams.delete(res); });
}
function broadcast(rev) { for (const s of streams) s.write(`event: rev\ndata: ${rev}\n\n`); }

/* ---------- routes ---------- */
async function login(req, res) {
  const ip = clientIp(req);
  const wait = auth.lockedFor(ip);
  if (wait) return sendJson(res, 429, { error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60000)} min.` });
  const { password } = await readJson(req, 10_000);
  if (typeof password !== 'string' || !password || password.length > 1024) return sendJson(res, 400, { error: 'Enter your password.' });
  if (!(await auth.checkPassword(password))) {
    auth.recordFailure(ip);
    console.warn(`Failed sign-in from ${ip}`);
    return sendJson(res, 401, { error: "That password isn't right." });
  }
  auth.clearFailures(ip);
  res.setHeader('Set-Cookie', auth.sessionCookie(auth.startSession(req.headers['user-agent']), SECURE_COOKIE));
  sendJson(res, 200, { ok: true });
}

async function route(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  const m = req.method;
  if (m !== 'GET' && m !== 'HEAD' && !sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-site request refused' });

  if (m === 'GET' && PUBLIC_FILES[p]) {
    if (p === '/login' && auth.sessionFromReq(req)) return redirect(res, './');
    return sendFile(res, PUBLIC_FILES[p]);
  }
  if (m === 'POST' && p === '/api/login') return login(req, res);

  // Everything below needs a valid session.
  if (!auth.sessionFromReq(req)) {
    return p.startsWith('/api/') ? sendJson(res, 401, { error: 'Sign in required' }) : redirect(res, 'login');
  }
  if (m === 'POST' && p === '/api/logout') {
    auth.endSession(req);
    res.setHeader('Set-Cookie', auth.clearCookie(SECURE_COOKIE));
    return sendJson(res, 200, { ok: true });
  }
  if (m === 'GET' && p === '/api/state') return sendJson(res, 200, store.snapshot());
  if (m === 'POST' && p === '/api/ops') {
    const { ops } = await readJson(req);
    const rev = store.apply(ops);
    broadcast(rev);
    return sendJson(res, 200, { rev });
  }
  if (m === 'GET' && p === '/api/events') return openStream(req, res);
  if (m === 'GET' && PRIVATE_FILES[p]) return sendFile(res, PRIVATE_FILES[p]);
  sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch(e => {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) sendJson(res, status, { error: e.expose ? e.message : 'Server error' });
  });
});
server.listen(PORT, HOST, () => console.log(`Drift Lists on http://${HOST}:${PORT}  (public origin ${PUBLIC_ORIGIN})`));

function shutdown() { store.save(); auth.saveSessions(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
