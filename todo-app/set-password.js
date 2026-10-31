'use strict';
// Sets (or changes) the sign-in password. Stores only an scrypt hash, and
// signs out every device. Usage: node set-password.js [--data <dir>]
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const auth = require('./auth');

const i = process.argv.indexOf('--data');
const dataDir = path.resolve(i > 0 ? process.argv[i + 1] : process.env.DATA_DIR || path.join(__dirname, 'data'));

async function readHidden(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = () => {};          // don't echo what you type
  process.stdout.write(question);
  const answer = await new Promise(r => rl.question('', r));
  rl.close();
  process.stdout.write('\n');
  return answer;
}
async function readPiped() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s.split(/\r?\n/)[0];
}

(async () => {
  let pw;
  if (process.stdin.isTTY) {
    pw = await readHidden('New password: ');
    if (pw !== await readHidden('Type it again: ')) { console.error('The two passwords did not match.'); process.exit(1); }
  } else pw = await readPiped();

  if (pw.length < 10) { console.error('Use at least 10 characters. A few random words works well.'); process.exit(1); }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'auth.json'),
    JSON.stringify({ passwordHash: await auth.hashPassword(pw), updatedAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 });
  fs.rmSync(path.join(dataDir, 'sessions.json'), { force: true });
  console.log(`Password saved to ${path.join(dataDir, 'auth.json')}. All devices are signed out.`);
})();
