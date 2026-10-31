'use strict';
// Lists and tasks kept in one JSON file. Fine for one person's todo lists;
// swap this module for SQLite/Postgres later without touching server.js.
const fs = require('node:fs');
const path = require('node:path');

const COLORS = new Set(['dawn', 'rose', 'iris', 'harbor', 'lagoon', 'moss', 'amber']);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LISTS = 200, MAX_ITEMS = 10000;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isBool = v => typeof v === 'boolean';
const isText = max => v => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

const FIELDS = {
  list: { name: isText(80), color: v => COLORS.has(v), pinned: isBool, order: isNum, createdAt: isNum },
  item: { listId: v => typeof v === 'string' && ID.test(v), text: isText(500), done: isBool,
          order: isNum, createdAt: isNum, doneAt: v => v === null || isNum(v) },
};
const REQUIRED = { list: ['name'], item: ['listId', 'text'] };

let file, state = { rev: 0, lists: {}, items: {} }, saveTimer = null;

function init(dataDir) {
  file = path.join(dataDir, 'db.json');
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}

const bad = message => Object.assign(new Error(message), { status: 400, expose: true });

function clean(kind, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('data must be an object');
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    const ok = FIELDS[kind][k];
    if (!ok) throw bad(`Unknown ${kind} field "${k}"`);
    if (!ok(v)) throw bad(`Invalid value for ${kind} field "${k}"`);
    out[k] = v;
  }
  return out;
}

// ops: [{ op: 'put' | 'delete', kind: 'list' | 'item', id, data? }]
// 'put' merges into the record (creating it if needed). The whole batch
// applies or none of it does.
function apply(ops) {
  if (!Array.isArray(ops) || ops.length < 1 || ops.length > 500) throw bad('ops must be an array of 1-500 operations');
  const next = structuredClone(state);
  for (const o of ops) {
    if (!o || (o.kind !== 'list' && o.kind !== 'item')) throw bad('kind must be "list" or "item"');
    if (typeof o.id !== 'string' || !ID.test(o.id)) throw bad('id must be 1-64 letters, digits, _ or -');
    const table = o.kind === 'list' ? next.lists : next.items;
    if (o.op === 'delete') {
      delete table[o.id];
      if (o.kind === 'list') for (const [id, it] of Object.entries(next.items)) if (it.listId === o.id) delete next.items[id];
    } else if (o.op === 'put') {
      const data = clean(o.kind, o.data);
      const merged = { ...table[o.id], ...data };
      for (const f of REQUIRED[o.kind]) if (merged[f] === undefined) throw bad(`New ${o.kind} needs "${f}"`);
      if (o.kind === 'item' && !next.lists[merged.listId]) throw bad('That list no longer exists');
      table[o.id] = merged;
    } else throw bad('op must be "put" or "delete"');
  }
  if (Object.keys(next.lists).length > MAX_LISTS || Object.keys(next.items).length > MAX_ITEMS) {
    throw Object.assign(new Error('Storage limit reached. Delete some lists or tasks.'), { status: 413, expose: true });
  }
  next.rev = state.rev + 1;
  state = next;
  scheduleSave();
  return state.rev;
}

function snapshot() {
  const rows = obj => Object.entries(obj).map(([id, v]) => ({ id, ...v }));
  return { rev: state.rev, lists: rows(state.lists), items: rows(state.items) };
}
const rev = () => state.rev;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 200);
}
function save() {
  clearTimeout(saveTimer);
  if (!file) return;
  const tmp = file + '.tmp';           // write-then-rename so a crash never leaves half a file
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

module.exports = { init, apply, snapshot, rev, save };
