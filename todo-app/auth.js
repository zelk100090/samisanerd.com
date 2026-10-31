'use strict';
// Password check, sessions and login throttling. No dependencies: node:crypto only.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
// scrypt is deliberately slow (~100 ms per guess), which makes guessing expensive.
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const COOKIE = 'drift_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // sliding: renewed while you keep using it
const MAX_FAILS = 5;                       // wrong passwords allowed per window, per IP
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;            // doubles on each repeat lockout, up to a day

let authFile, sessionsFile, passwordHash = null, saveTimer = null;
const sessions = new Map(); // sha256(token) -> { created, expires, ua }
const failures = new Map(); // ip -> { count, first, lockedUntil, strikes }

function init(dataDir) {
  authFile = path.join(dataDir, 'auth.json');
  sessionsFile = path.join(dataDir, 'sessions.json');
  try { passwordHash = JSON.parse(fs.readFileSync(authFile, 'utf8')).passwordHash || null; } catch {}
  try {
    const now = Date.now();
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(sessionsFile, 'utf8')))) {
      if (v.expires > now) sessions.set(k, v);
    }
  } catch {}
  return !!passwordHash;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 64, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function checkPassword(password) {
  if (!passwordHash) return false;
  const [alg, N, r, p, salt, key] = passwordHash.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length,
    { N: +N, r: +r, p: +p, maxmem: PARAMS.maxmem });
  return crypto.timingSafeEqual(actual, expected); // same time whether 1 or 60 bytes match
}

/* ---------- throttling ---------- */
function lockedFor(ip) {
  const f = failures.get(ip);
  return f && f.lockedUntil > Date.now() ? f.lockedUntil - Date.now() : 0;
}
function recordFailure(ip) {
  const now = Date.now();
  let f = failures.get(ip);
  if (!f || now - f.first > FAIL_WINDOW_MS) f = { count: 0, first: now, lockedUntil: 0, strikes: f ? f.strikes : 0 };
  f.count++;
  if (f.count >= MAX_FAILS) {
    f.strikes++;
    f.lockedUntil = now + Math.min(LOCK_MS * 2 ** (f.strikes - 1), 24 * 60 * 60 * 1000);
    f.count = 0; f.first = now;
  }
  failures.set(ip, f);
}
function clearFailures(ip) { failures.delete(ip); }

/* ---------- sessions ---------- */
// The cookie holds a random token; the server keeps only its SHA-256, so a
// leaked sessions.json can't be replayed as a cookie.
const digest = token => crypto.createHash('sha256').update(token).digest('hex');

function startSession(ua) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  sessions.set(digest(token), { created: now, expires: now + SESSION_MS, ua: String(ua || '').slice(0, 200) });
  scheduleSave();
  return token;
}
function tokenFrom(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}
function sessionFromReq(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const key = digest(token), s = sessions.get(key), now = Date.now();
  if (!s) return null;
  if (s.expires <= now) { sessions.delete(key); scheduleSave(); return null; }
  if (s.expires - now < SESSION_MS - 60 * 60 * 1000) { s.expires = now + SESSION_MS; scheduleSave(); }
  return s;
}
function endSession(req) {
  const token = tokenFrom(req);
  if (token && sessions.delete(digest(token))) scheduleSave();
}
function sessionCookie(token, secure) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
}
function clearCookie(secure) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSessions, 500);
}
function saveSessions() {
  clearTimeout(saveTimer);
  if (!sessionsFile) return;
  const tmp = sessionsFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
  fs.renameSync(tmp, sessionsFile);
}

module.exports = {
  init, hashPassword, checkPassword,
  lockedFor, recordFailure, clearFailures,
  startSession, sessionFromReq, endSession, sessionCookie, clearCookie, saveSessions,
};
