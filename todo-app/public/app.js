(() => {
  const $ = id => document.getElementById(id);

  const COLORS = [
    { id: 'dawn', hex: '#ec9468', name: 'Dawn' },
    { id: 'rose', hex: '#e0739a', name: 'Rose' },
    { id: 'iris', hex: '#8b7cf6', name: 'Iris' },
    { id: 'harbor', hex: '#5a8ad8', name: 'Harbor' },
    { id: 'lagoon', hex: '#36a9b2', name: 'Lagoon' },
    { id: 'moss', hex: '#72a85c', name: 'Moss' },
    { id: 'amber', hex: '#d6a33a', name: 'Amber' },
  ];
  const colorHex = id => (COLORS.find(c => c.id === id) || COLORS[2]).hex;

  const local = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const loadQueue = () => { try { return JSON.parse(local.get('drift.queue') || '[]'); } catch { return []; } };

  const S = {
    lists: [], items: [], rev: 0, loaded: false, online: true,
    queue: loadQueue(), sending: false, retries: 0,
    active: local.get('drift.active'), focusTitle: false,
    editing: null, armedDelete: false, swIdx: 0,
  };

  // Tasks appear in the order you drag them into. Each task's `order` is just
  // a number to sort by; new tasks start at Date.now() so they land at the bottom.
  const byOrder = items => items.slice().sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);

  // Picks the `order` for a task dropped between two neighbours. `prev` and
  // `next` are their order numbers, or null at the top/bottom of the list.
  // Returns null when there's no room left, and the caller renumbers instead.
  function orderBetween(prev, next) {
    if (prev == null && next == null) return Date.now();
    if (prev == null) return next - 1;
    if (next == null) return prev + 1;
    // Orders are ~1.8e12, so a double only has ~12 bits left for fractions.
    // Renumber long before halving runs out of precision.
    if (next - prev < 1e-3) return null;
    return (prev + next) / 2;
  }

  const orderedLists = () => {
    const ls = [...S.lists].sort((a, b) => (a.order || 0) - (b.order || 0));
    return [...ls.filter(l => l.pinned), ...ls.filter(l => !l.pinned)];
  };
  const activeList = () => S.lists.find(l => l.id === S.active) || null;
  const itemsOf = id => S.items.filter(i => i.listId === id);

  // Tasks nest to any depth: a task's `parentId` names the task it sits under.
  // treeOf() gives the list in display order, each row with its depth and parent.
  // A missing parent (deleted on another device) makes a task top-level.
  function treeOf(listId) {
    const its = itemsOf(listId), byId = new Map(its.map(i => [i.id, i])), kids = new Map();
    const hasParent = i => i.parentId && i.parentId !== i.id && byId.has(i.parentId);
    for (const i of its) if (hasParent(i)) (kids.get(i.parentId) || kids.set(i.parentId, []).get(i.parentId)).push(i);
    const rows = [], seen = new Set();
    const walk = (it, depth, parent) => {
      if (seen.has(it.id)) return;
      seen.add(it.id);
      rows.push({ it, depth, parent });
      for (const c of byOrder(kids.get(it.id) || [])) walk(c, depth + 1, it.id);
    };
    for (const t of byOrder(its.filter(i => !hasParent(i)))) walk(t, 0, null);
    // Tasks caught in a parent loop (two devices nesting tasks into each other at
    // the same moment) never get reached from the top, so show them top-level.
    for (const i of byOrder(its)) walk(i, 0, null);
    return rows;
  }
  const siblingsOf = (listId, parentId) => treeOf(listId).filter(r => r.parent === parentId).map(r => r.it);
  const childrenOf = (listId, id) => siblingsOf(listId, id);
  // Everything nested under a task, at any depth (rows right after it that sit deeper).
  function subtreeOf(listId, id) {
    const rows = treeOf(listId), i = rows.findIndex(r => r.it.id === id), out = [];
    if (i < 0) return out;
    for (let j = i + 1; j < rows.length && rows[j].depth > rows[i].depth; j++) out.push(rows[j].it);
    return out;
  }
  // How finished each task is, 0..1: done counts as 1, otherwise the average of
  // its subtasks (so a half-finished subtask counts as half).
  function progressOf(rows) {
    const kids = new Map(), p = new Map();
    for (const r of rows) if (r.parent) (kids.get(r.parent) || kids.set(r.parent, []).get(r.parent)).push(r.it);
    for (let i = rows.length - 1; i >= 0; i--) { // children come after parents, so walk backwards
      const it = rows[i].it, ks = kids.get(it.id) || [];
      p.set(it.id, it.done ? 1 : ks.length ? ks.reduce((s, k) => s + p.get(k.id), 0) / ks.length : 0);
    }
    return { p, kids };
  }

  // An `order` that puts a task right after `afterId` among `parentId`'s tasks
  // (first, when afterId is null). Also returns ops if the siblings needed renumbering.
  function slot(listId, parentId, afterId, movingId) {
    const sibs = siblingsOf(listId, parentId).filter(i => i.id !== movingId);
    const at = afterId ? sibs.findIndex(i => i.id === afterId) + 1 : 0;
    const prev = sibs[at - 1], next = sibs[at];
    const o = orderBetween(prev ? prev.order : null, next ? next.order : null);
    if (o != null && (!prev || o > prev.order) && (!next || o < next.order)) return { order: o, ops: [] };
    const base = sibs.length ? Math.min(...sibs.map(i => i.order)) : Date.now();
    const ops = [];
    sibs.forEach((s, i) => {
      const v = base + (i < at ? i : i + 1); // leave a gap at `at`
      if (v !== s.order) ops.push({ op: 'put', kind: 'item', id: s.id, data: { order: v } });
    });
    return { order: base + at, ops };
  }
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');

  /* ---------- sync with the server ----------
     Every change is an op: { op: 'put' | 'delete', kind: 'list' | 'item', id, data }.
     It's applied to the screen at once, queued (and kept in localStorage so an
     offline edit survives a reload), then sent in order. When the server says
     the data changed (rev went up), we re-fetch and replay unsent ops on top. */
  const saveQueue = () => local.set('drift.queue', JSON.stringify(S.queue));
  const goLogin = () => { location.href = 'login'; };

  function applyLocal(o) {
    if (o.kind === 'list') {
      const i = S.lists.findIndex(x => x.id === o.id);
      if (o.op === 'delete') { if (i >= 0) S.lists.splice(i, 1); S.items = S.items.filter(it => it.listId !== o.id); }
      else if (i >= 0) S.lists[i] = { ...S.lists[i], ...o.data };
      else S.lists.push({ id: o.id, ...o.data });
    } else {
      const i = S.items.findIndex(x => x.id === o.id);
      if (o.op === 'delete') { if (i >= 0) S.items.splice(i, 1); }
      else if (i >= 0) S.items[i] = { ...S.items[i], ...o.data };
      else S.items.push({ id: o.id, ...o.data });
    }
  }
  function send(ops) {
    ops.forEach(applyLocal);
    S.queue.push(...ops); saveQueue();
    render(); flush();
  }

  let retryTimer = null;
  async function flush() {
    if (S.sending || !S.queue.length) return;
    S.sending = true; clearTimeout(retryTimer); renderSync();
    const batch = S.queue.slice(0, 200);
    let ok = false;
    try {
      const r = await fetch('api/ops', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops: batch }) });
      if (r.status === 401) return goLogin();
      if (r.status >= 500) throw new Error('server ' + r.status);
      S.queue.splice(0, batch.length); saveQueue();
      S.online = true; S.retries = 0; ok = true;
      if (r.ok) {
        const { rev } = await r.json();
        if (rev === S.rev + 1 && !refreshing) S.rev = rev; else refresh(true);
      } else {
        // The server refused these changes (bad data, list gone, storage full): drop them and resync.
        const msg = (await r.json().catch(() => ({}))).error;
        toast(msg ? `Couldn't save: ${msg}` : "Couldn't save that change.");
        refresh(true);
      }
    } catch {
      S.online = false;
      retryTimer = setTimeout(flush, Math.min(30000, 1000 * 2 ** S.retries++));
    } finally {
      S.sending = false; renderSync();
      if (ok && S.queue.length) flush();
    }
  }

  let refreshing = null, refreshAgain = false;
  function refresh(force) {
    if (refreshing) { if (force) refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      try {
        const r = await fetch('api/state', { cache: 'no-store' });
        if (r.status === 401) return goLogin();
        if (!r.ok) throw new Error('server ' + r.status);
        const st = await r.json();
        S.lists = st.lists; S.items = st.items; S.rev = st.rev;
        S.queue.forEach(applyLocal); // keep changes that haven't reached the server yet
        S.loaded = true; S.online = true;
      } catch { S.online = false; }
      finally {
        refreshing = null;
        if (!S.editing && !$('switcher').hidden) renderSwitcher();
        render();
        if (refreshAgain) { refreshAgain = false; refresh(); }
      }
    })();
    return refreshing;
  }

  function connectEvents() {
    const es = new EventSource('api/events');
    es.addEventListener('rev', e => {
      S.online = true;
      if (+e.data !== S.rev || !S.loaded) refresh(true); else renderSync();
      flush();
    });
    es.onerror = () => {
      S.online = false; renderSync();
      // The browser reconnects by itself unless the server refused us (e.g. signed out).
      if (es.readyState === EventSource.CLOSED) setTimeout(() => { refresh(); connectEvents(); }, 5000);
    };
  }

  /* ---------- actions ---------- */
  function setActive(id, dir) {
    if (!id || id === S.active) { closeDrawer(); return; }
    S.active = id; local.set('drift.active', id);
    S.armedDelete = false; S.editing = null;
    closeDrawer(); closePops();
    const p = $('panel');
    p.classList.remove('slide-next', 'slide-prev');
    if (dir) { void p.offsetWidth; p.classList.add(dir > 0 ? 'slide-next' : 'slide-prev'); }
    render();
  }
  function step(d) {
    const ls = orderedLists(); if (ls.length < 2) return;
    const i = Math.max(0, ls.findIndex(l => l.id === S.active));
    setActive(ls[(i + d + ls.length) % ls.length].id, d);
  }
  function newList(name) {
    const id = newId(), now = Date.now();
    const used = S.lists.map(l => l.color);
    const color = (COLORS.find(c => !used.includes(c.id)) || COLORS[S.lists.length % COLORS.length]).id;
    S.focusTitle = !name;
    send([{ op: 'put', kind: 'list', id, data: { name: name || 'New list', color, pinned: false, order: now, createdAt: now } }]);
    setActive(id);
  }
  const putList = (id, data) => send([{ op: 'put', kind: 'list', id, data }]);
  function updateList(patch) { const l = activeList(); if (l) putList(l.id, patch); }
  function addItem(text) {
    const l = activeList(); text = text.trim();
    if (!l || !text) return;
    const now = Date.now();
    const order = Math.max(now, ...itemsOf(l.id).map(i => i.order + 1)); // always below a task dragged to the bottom
    send([{ op: 'put', kind: 'item', id: newId(), data: { listId: l.id, text, done: false, order, createdAt: now, doneAt: null } }]);
  }
  function toggleItem(it) {
    send([{ op: 'put', kind: 'item', id: it.id, data: { done: !it.done, doneAt: it.done ? null : Date.now() } }]);
  }
  function placeItem(id, parentId, afterId, extra = []) {
    const l = activeList(); if (!l) return;
    const { order, ops } = slot(l.id, parentId, afterId, id);
    send([...ops, { op: 'put', kind: 'item', id, data: { order, parentId } }, ...extra]);
  }
  // Tab: become the last subtask of the task above it at the same level.
  // Its own subtasks stay nested under it.
  function indent(id) {
    const l = activeList(), r = treeOf(l.id).find(x => x.it.id === id);
    if (!r) return false;
    const sibs = siblingsOf(l.id, r.parent), i = sibs.findIndex(s => s.id === id);
    if (i < 1) return false;
    const parentId = sibs[i - 1].id, last = childrenOf(l.id, parentId).pop();
    placeItem(id, parentId, last ? last.id : null);
    return true;
  }
  // Shift+Tab: move out one level, right after its old parent. Siblings below it
  // become its subtasks (after any it already has), like an outliner, so nothing jumps.
  function outdent(id) {
    const l = activeList(), rows = treeOf(l.id), r = rows.find(x => x.it.id === id);
    if (!r || !r.parent) return false;
    const grandparent = rows.find(x => x.it.id === r.parent).parent;
    const sibs = childrenOf(l.id, r.parent), later = sibs.slice(sibs.findIndex(s => s.id === id) + 1);
    const own = childrenOf(l.id, id), base = own.length ? own[own.length - 1].order : 0;
    placeItem(id, grandparent, r.parent,
      later.map((s, j) => ({ op: 'put', kind: 'item', id: s.id, data: { parentId: id, order: base + j + 1 } })));
    return true;
  }
  // Enter while editing: a new empty task right below, opened for typing. Below a
  // task that has subtasks, it becomes the first subtask.
  function addBelow(id) {
    const l = activeList(), rows = treeOf(l.id), r = rows.find(x => x.it.id === id);
    if (!r) return;
    const hasKids = rows.some(x => x.parent === id);
    const parentId = hasKids ? id : r.parent;
    const { order, ops } = slot(l.id, parentId, hasKids ? null : id, null);
    const nid = newId(), now = Date.now();
    S.editNext = nid;
    send([...ops, { op: 'put', kind: 'item', id: nid, data: { listId: l.id, text: '', done: false, order, createdAt: now, doneAt: null, parentId } }]);
  }
  const withSubtasks = it => [it, ...subtreeOf(it.listId, it.id)];
  function deleteItems(its, label) {
    if (!its.length) return;
    const saved = its.map(({ id, ...data }) => ({ op: 'put', kind: 'item', id, data }));
    send(its.map(i => ({ op: 'delete', kind: 'item', id: i.id })));
    toast(label, () => send(saved));
  }
  function deleteActiveList() {
    const l = activeList(); if (!l) return;
    const ls = orderedLists(); const i = ls.findIndex(x => x.id === l.id);
    const next = ls[i + 1] || ls[i - 1];
    S.active = next ? next.id : null; local.set('drift.active', S.active || '');
    closePops();
    send([{ op: 'delete', kind: 'list', id: l.id }]); // the server deletes its tasks too
    toast(`Deleted “${l.name || 'Untitled'}”`);
  }
  async function signOut() {
    try { await fetch('api/logout', { method: 'POST' }); } catch {}
    goLogin();
  }

  /* ---------- rendering ---------- */
  function ensureActive() {
    if (S.active && S.lists.some(l => l.id === S.active)) return;
    const first = orderedLists()[0];
    S.active = first ? first.id : null;
  }
  function render() {
    ensureActive();
    const l = activeList();
    $('app').style.setProperty('--accent', l ? colorHex(l.color) : COLORS[2].hex);
    renderSidebar(); renderMain(); renderSync();
  }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const PIN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M9 3h6l-1 6 4 4H6l4-4z"/><path d="M12 13v8"/></svg>';

  function renderSidebar() {
    const pinned = $('pinned'), tabs = $('tabs');
    pinned.replaceChildren(); tabs.replaceChildren();
    orderedLists().forEach((l, idx) => {
      const open = itemsOf(l.id).filter(i => !i.done).length;
      const name = l.name || 'Untitled';
      const shortcut = idx < 9 ? ` (Alt+${idx + 1})` : '';
      if (l.pinned) {
        const t = el('button', 'tile'); t.type = 'button';
        t.style.setProperty('--c', colorHex(l.color));
        t.setAttribute('aria-current', l.id === S.active); t.title = name + shortcut;
        t.append(el('b', '', (name.trim()[0] || '·').toUpperCase()), el('span', '', name));
        t.onclick = () => setActive(l.id);
        pinned.append(t);
      } else {
        const row = el('div', 'tab'); row.style.setProperty('--c', colorHex(l.color));
        row.setAttribute('aria-current', l.id === S.active);
        const main = el('button', 'tab-main'); main.type = 'button'; main.title = name + shortcut;
        main.append(el('i', 'dot'), el('span', 'name', name), el('span', 'n', open ? String(open) : ''));
        main.onclick = () => setActive(l.id);
        const pin = el('button', 'tab-pin'); pin.type = 'button'; pin.title = 'Pin to top'; pin.setAttribute('aria-label', 'Pin ' + name);
        pin.innerHTML = PIN_SVG;
        pin.onclick = () => putList(l.id, { pinned: true });
        row.append(main, pin);
        tabs.append(row);
      }
    });
    pinned.hidden = !pinned.children.length;
  }

  function emptyState() {
    const box = $('empty'); box.replaceChildren();
    const say = (h, p) => { box.append(el('strong', '', h), document.createTextNode(p)); };
    if (!S.loaded && !S.online) say("Can't reach your server", "Check your connection. Your lists will appear as soon as it's back.");
    else if (!S.loaded) say('Loading your lists…', 'Fetching the latest from your server.');
    else if (!S.lists.length) {
      say('No lists yet', 'Make one for school, one for home, one for whatever else. Switch between them from the sidebar.');
      const b = el('button', 'btn', 'New list'); b.type = 'button'; b.onclick = () => newList();
      box.append(document.createElement('br'), b);
    }
    else say('Nothing here yet', 'Type a task above and press Enter.');
    box.hidden = false;
  }

  function renderMain() {
    const l = activeList(), panel = $('panel');
    panel.classList.toggle('no-list', !l);
    if (!l) { $('items').replaceChildren(); emptyState(); return; }
    const title = $('title');
    if (document.activeElement !== title) title.value = l.name || '';
    if (S.focusTitle) { S.focusTitle = false; title.focus(); title.select(); }
    const rows = treeOf(l.id), its = rows.map(r => r.it);
    const done = its.filter(i => i.done).length;
    $('count').textContent = its.length ? `${done} of ${its.length} done` : 'No tasks';
    $('bar').style.width = its.length ? (done / its.length * 100) + '%' : '0';
    $('pinBtn').setAttribute('aria-pressed', !!l.pinned);
    $('pinBtn').title = l.pinned ? 'Unpin' : 'Pin to top';
    $('clearDone').hidden = !done;
    $('clearDoneMenu').hidden = !done;
    const del = $('deleteList');
    del.classList.toggle('armed', S.armedDelete);
    del.textContent = S.armedDelete ? `Confirm: delete list and ${its.length} task${its.length === 1 ? '' : 's'}` : 'Delete list';
    renderSwatches(l);
    if (S.editing || drag) return; // don't rebuild rows under your cursor
    renderItems(rows);
    if (its.length) $('empty').hidden = true; else emptyState();
    if (S.editNext) { const id = S.editNext; S.editNext = null; startEdit(id); }
  }

  const CHECK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const X_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  const GRIP_SVG = '<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>';
  // pathLength=100 lets the dash length be the percentage directly.
  const ringSvg = pct => '<svg class="ring-svg" viewBox="0 0 22 22" aria-hidden="true">'
    + '<circle class="ring-track" cx="11" cy="11" r="9.75" pathLength="100"/>'
    + (pct ? `<circle class="ring-fill" cx="11" cy="11" r="9.75" pathLength="100" stroke-dasharray="${pct} 100"/>` : '')
    + '</svg>';
  function renderItems(rows) {
    const focusedGrip = document.activeElement?.closest?.('.grip')?.closest('.item')?.dataset.id;
    const { p, kids } = progressOf(rows);
    $('items').replaceChildren(...rows.map(({ it, depth, parent }) => {
      const li = el('li', 'item' + (depth ? ' child' : '') + (it.done ? ' done' : ''));
      li.dataset.id = it.id; li.dataset.depth = depth;
      li.style.setProperty('--depth', depth);
      if (parent) li.dataset.parent = parent;
      const c = el('button', 'check'); c.type = 'button'; c.setAttribute('role', 'checkbox');
      c.setAttribute('aria-checked', !!it.done); c.setAttribute('aria-label', it.text || 'Untitled task'); c.innerHTML = CHECK_SVG;
      // Two or more subtasks: the checkbox turns into a ring that fills as they get done.
      const ks = kids.get(it.id) || [];
      if (ks.length >= 2 && !it.done) {
        const pct = Math.round(p.get(it.id) * 100);
        c.classList.add('ring');
        c.title = `${ks.filter(k => k.done).length} of ${ks.length} subtasks done · ${pct}%`;
        c.setAttribute('aria-label', `${it.text || 'Untitled task'}, ${pct}% done`);
        c.innerHTML = ringSvg(pct) + CHECK_SVG;
      }
      const d = el('button', 'del'); d.type = 'button'; d.setAttribute('aria-label', 'Delete task'); d.innerHTML = X_SVG;
      const g = el('button', 'grip'); g.type = 'button'; g.title = 'Drag to reorder';
      g.setAttribute('aria-label', 'Reorder task (drag, or use the arrow keys)'); g.innerHTML = GRIP_SVG;
      li.append(g, c, el('span', it.text ? 'text' : 'text blank', it.text || 'Untitled task'), d);
      return li;
    }));
    if (focusedGrip) $('items').querySelector(`.item[data-id="${focusedGrip}"] .grip`)?.focus();
  }
  function renderSwatches(l) {
    const box = $('swatches');
    if (box.childElementCount !== COLORS.length) {
      box.replaceChildren(...COLORS.map(c => {
        const b = el('button', 'sw'); b.type = 'button'; b.setAttribute('role', 'radio');
        b.style.setProperty('--c', c.hex); b.title = c.name; b.setAttribute('aria-label', c.name); b.dataset.c = c.id;
        b.onclick = () => updateList({ color: c.id });
        return b;
      }));
    }
    [...box.children].forEach(b => b.setAttribute('aria-checked', b.dataset.c === (l.color || 'iris')));
  }
  function renderSync() {
    const s = $('sync'), n = S.queue.length; let cls, text;
    if (!S.online) [cls, text] = ['warn', n ? `Offline · ${n} to sync` : 'Offline'];
    else if (!S.loaded) [cls, text] = ['wait', 'Loading…'];
    else if (n || S.sending) [cls, text] = ['wait', 'Saving…'];
    else [cls, text] = ['ok', 'Synced'];
    s.className = 'sync ' + cls; s.lastElementChild.textContent = text;
  }

  /* ---------- inline editing ---------- */
  // Enter: save and start a new task below. Tab / Shift+Tab: indent / outdent
  // and keep typing. Esc: cancel. Clicking away saves; a task left blank is removed.
  function startEdit(id) {
    const li = $('items').querySelector(`.item[data-id="${id}"]`);
    const it = S.items.find(i => i.id === id);
    if (!li || !it) return;
    S.editing = id;
    const input = el('input', 'edit');
    input.value = it.text; input.maxLength = 500; input.placeholder = 'New task'; input.enterKeyHint = 'next';
    input.setAttribute('aria-label', 'Edit task');
    li.querySelector('.text').replaceWith(input);
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    let finished = false;
    // mode: 'save' (blur/Enter on blank), 'keep' (moving on: keep it even if blank), 'cancel' (Esc)
    const finish = mode => {
      if (finished) return; finished = true; S.editing = null;
      const v = mode === 'cancel' ? it.text : input.value.trim();
      if (!v && mode !== 'keep' && !childrenOf(it.listId, it.id).length) {
        if (it.text) deleteItems([it], 'Deleted empty task');
        else send([{ op: 'delete', kind: 'item', id: it.id }]); // a new task you never typed in
      } else if (v !== it.text) send([{ op: 'put', kind: 'item', id: it.id, data: { text: v } }]);
      else render();
    };
    input.onkeydown = e => {
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!input.value.trim()) finish('save'); // Enter on a blank task ends the run
        else { finish('keep'); addBelow(it.id); }
      } else if (e.key === 'Tab') {
        e.preventDefault();
        finish('keep');
        S.editNext = it.id; // reopen this task after it moves
        if (!(e.shiftKey ? outdent(it.id) : indent(it.id))) { S.editNext = null; startEdit(it.id); }
      } else if (e.key === 'Escape') { e.stopPropagation(); finish('cancel'); }
    };
    input.onblur = () => finish('save');
  }

  /* ---------- drag to reorder ---------- */
  // Mouse: grab a task anywhere and move it 5px to start dragging (a plain click
  // still ticks/edits). Touch: drag by the grip, so the list still scrolls.
  // Drag right to make it a subtask of the task above, left to un-nest it.
  let drag = null, suppressClick = false;
  const depthOfRow = r => +r.dataset.depth || 0;

  const scrollBox = () => $('scroll');
  const contentY = clientY => clientY - scrollBox().getBoundingClientRect().top + scrollBox().scrollTop;

  function startDrag(p, clientX, clientY) {
    // Everything nested under the task travels with it: hide it while it's in the air.
    const nested = new Set(subtreeOf(activeList().id, p.id).map(i => i.id));
    const kids = [...$('items').children].filter(r => nested.has(r.dataset.id));
    kids.forEach(k => k.classList.add('drag-hidden'));
    const rows = [...$('items').children].filter(r => !r.classList.contains('drag-hidden'));
    const depth0 = depthOfRow(p.li);
    drag = {
      ...p, rows, kids, from: rows.indexOf(p.li), to: rows.indexOf(p.li),
      depth0, depth: depth0, prev: null,
      indent: parseFloat(getComputedStyle($('items')).getPropertyValue('--indent')) || 28, // px per level
      tops: rows.map(r => r.offsetTop), heights: rows.map(r => r.offsetHeight),
      startX: clientX, lastX: clientX, startY: contentY(clientY), lastY: clientY, raf: 0,
    };
    getSelection()?.removeAllRanges();
    $('items').classList.add('sorting');
    p.li.classList.add('dragging');
    addEventListener('pointermove', onDragMove, { passive: false });
    addEventListener('pointerup', onDragEnd);
    addEventListener('pointercancel', onDragCancel);
    drag.raf = requestAnimationFrame(autoScroll);
  }
  function layoutDrag() {
    const d = drag, dy = contentY(d.lastY) - d.startY;
    const mid = d.tops[d.from] + d.heights[d.from] / 2 + dy;
    let to = d.from;
    d.rows.forEach((_, i) => {
      const centre = d.tops[i] + d.heights[i] / 2;
      if (i < d.from && mid < centre) to = Math.min(to, i);
      if (i > d.from && mid > centre) to = Math.max(to, i);
    });
    d.to = to;
    // Depth follows the sideways drag, within what the spot allows: at most one
    // level deeper than the task above, and at least as deep as the task below
    // (otherwise you'd split that task off from its parent).
    const others = d.rows.filter((_, i) => i !== d.from);
    const prev = others[to - 1], next = others[to];
    const want = d.depth0 + Math.round((d.lastX - d.startX) / d.indent);
    const max = prev ? depthOfRow(prev) + 1 : 0;
    const min = next ? depthOfRow(next) : 0;
    d.depth = Math.min(Math.max(want, min), max);
    d.prev = prev;
    d.li.style.transform = `translate(${(d.depth - d.depth0) * d.indent}px, ${dy}px)`;
    const h = d.heights[d.from]; // rows between old and new spot slide over to make the gap
    d.rows.forEach((r, i) => {
      if (i === d.from) return;
      const shift = d.from < i && i <= to ? -h : to <= i && i < d.from ? h : 0;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  }
  function autoScroll() { // scroll the list while dragging near its top or bottom edge
    if (!drag) return;
    const box = scrollBox().getBoundingClientRect(), edge = 56, y = drag.lastY;
    const v = y < box.top + edge ? -(box.top + edge - y) / 4 : y > box.bottom - edge ? (y - box.bottom + edge) / 4 : 0;
    if (v) { scrollBox().scrollTop += v; layoutDrag(); }
    drag.raf = requestAnimationFrame(autoScroll);
  }
  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    layoutDrag();
  }
  function dropAt(d) {
    if (!d.prev) return placeItem(d.id, null, null); // very top of the list
    const info = new Map(treeOf(activeList().id).map(r => [r.it.id, r]));
    let x = info.get(d.prev.dataset.id);
    if (d.depth > x.depth) return placeItem(d.id, x.it.id, null); // first subtask of the task above
    // Otherwise it lands right after the task above, or after whichever of that
    // task's parents sits at the chosen depth.
    while (x.depth > d.depth) x = info.get(x.parent);
    placeItem(d.id, x.parent, x.it.id);
  }
  function finishDrag(commit) {
    const d = drag; if (!d) return;
    drag = null;
    cancelAnimationFrame(d.raf);
    removeEventListener('pointermove', onDragMove);
    removeEventListener('pointerup', onDragEnd);
    removeEventListener('pointercancel', onDragCancel);
    $('items').classList.remove('sorting');
    d.li.classList.remove('dragging');
    d.rows.forEach(r => { r.style.transform = ''; });
    d.kids.forEach(k => k.classList.remove('drag-hidden'));
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); // the drop isn't a click
    if (commit && (d.to !== d.from || d.depth !== d.depth0)) dropAt(d); else render();
  }
  const onDragEnd = e => { if (drag && e.pointerId === drag.pointerId) finishDrag(true); };
  const onDragCancel = e => { if (drag && e.pointerId === drag.pointerId) finishDrag(false); };

  $('items').addEventListener('pointerdown', e => {
    const li = e.target.closest('.item');
    if (!li || S.editing || drag || e.button !== 0) return;
    const p = { li, id: li.dataset.id, pointerId: e.pointerId };
    if (e.target.closest('.grip')) { e.preventDefault(); startDrag(p, e.clientX, e.clientY); return; }
    if (e.pointerType !== 'mouse' || e.target.closest('.check, .del, input')) return;
    const x0 = e.clientX, y0 = e.clientY;
    const watch = ev => {
      if (ev.pointerId !== p.pointerId) return;
      // Measure from where you pressed, not from where the 5px threshold was crossed.
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 5) { stop(); startDrag(p, x0, y0); onDragMove(ev); }
    };
    const stop = () => { removeEventListener('pointermove', watch); removeEventListener('pointerup', stop); };
    addEventListener('pointermove', watch);
    addEventListener('pointerup', stop);
  });
  // Keyboard: focus a task's grip (Tab), then ↑/↓ moves it among its siblings.
  $('items').addEventListener('keydown', e => {
    const grip = e.target.closest('.grip');
    if (!grip || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const id = grip.closest('.item').dataset.id, l = activeList();
    const parent = treeOf(l.id).find(r => r.it.id === id)?.parent ?? null;
    const sibs = siblingsOf(l.id, parent), i = sibs.findIndex(s => s.id === id);
    const j = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (i < 0 || j < 0 || j >= sibs.length) return;
    placeItem(id, parent, e.key === 'ArrowUp' ? (j > 0 ? sibs[j - 1].id : null) : sibs[j].id);
  });

  /* ---------- quick switcher ---------- */
  function openSwitcher() { closeDrawer(); $('switcher').hidden = false; $('swInput').value = ''; S.swIdx = 0; renderSwitcher(); $('swInput').focus(); }
  function closeSwitcher() { $('switcher').hidden = true; }
  function switcherRows() {
    const q = $('swInput').value.trim();
    const rows = orderedLists().filter(l => (l.name || '').toLowerCase().includes(q.toLowerCase())).map(l => ({ list: l }));
    if (q && !S.lists.some(l => (l.name || '').toLowerCase() === q.toLowerCase())) rows.push({ create: q });
    return rows;
  }
  function renderSwitcher() {
    const rows = switcherRows();
    S.swIdx = Math.min(S.swIdx, Math.max(0, rows.length - 1));
    $('swResults').replaceChildren(...rows.map((r, i) => {
      const b = el('button', 'res' + (i === S.swIdx ? ' sel' : '')); b.type = 'button';
      if (r.list) {
        const dot = el('i', 'dot'); dot.style.setProperty('--c', colorHex(r.list.color));
        const open = itemsOf(r.list.id).filter(x => !x.done).length;
        b.append(dot, el('span', 'name', r.list.name || 'Untitled'), el('span', 'n', open ? open + ' open' : ''));
      } else b.append(el('span', 'name', `Create list “${r.create}”`), el('kbd', '', 'Enter'));
      b.onclick = () => chooseRow(r);
      return b;
    }));
  }
  function chooseRow(r) { closeSwitcher(); if (!r) return; if (r.list) setActive(r.list.id); else newList(r.create); }

  /* ---------- chrome: drawer, compact, popovers, toasts ---------- */
  const mq = matchMedia('(max-width: 759px)');
  function applyLayout() {
    $('app').classList.toggle('mobile', mq.matches);
    $('app').classList.toggle('compact', !mq.matches && local.get('drift.compact') === '1');
    if (!mq.matches) closeDrawer();
  }
  function toggleCompact() {
    if (mq.matches) { $('app').classList.toggle('drawer-open'); return; }
    local.set('drift.compact', $('app').classList.contains('compact') ? '0' : '1'); applyLayout();
  }
  function closeDrawer() { $('app').classList.remove('drawer-open'); }
  function closePops() {
    $('colorPop').hidden = $('morePop').hidden = true;
    $('colorBtn').setAttribute('aria-expanded', false); $('moreBtn').setAttribute('aria-expanded', false);
    if (S.armedDelete) { S.armedDelete = false; renderMain(); }
  }
  function togglePop(pop, btn) {
    const open = pop.hidden; closePops();
    pop.hidden = !open; btn.setAttribute('aria-expanded', open);
  }
  function toast(msg, undo) {
    const t = el('div', 'toast'); t.append(el('span', '', msg));
    if (undo) { const b = el('button', '', 'Undo'); b.type = 'button'; b.onclick = () => { undo(); t.remove(); }; t.append(b); }
    $('toasts').append(t);
    setTimeout(() => t.remove(), undo ? 6000 : 4000);
  }

  /* ---------- events ---------- */
  $('addForm').addEventListener('submit', e => { e.preventDefault(); addItem($('addInput').value); $('addInput').value = ''; });
  $('items').addEventListener('click', e => {
    const li = e.target.closest('.item'); if (!li || suppressClick || e.target.closest('.grip')) return;
    const it = S.items.find(i => i.id === li.dataset.id); if (!it) return;
    if (e.target.closest('.check')) toggleItem(it);
    else if (e.target.closest('.del')) {
      const name = it.text || 'Untitled task', all = withSubtasks(it);
      deleteItems(all, `Deleted “${name.length > 32 ? name.slice(0, 32) + '…' : name}”${all.length > 1 ? ` and ${all.length - 1} subtask${all.length > 2 ? 's' : ''}` : ''}`);
    }
    else if (e.target.closest('.text')) startEdit(it.id);
  });
  const title = $('title');
  title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } if (e.key === 'Escape') { const l = activeList(); title.value = l ? l.name : ''; title.blur(); } });
  title.addEventListener('blur', () => { const l = activeList(); const v = title.value.trim(); if (l && v && v !== l.name) updateList({ name: v }); else if (l) title.value = l.name; });
  $('pinBtn').onclick = () => { const l = activeList(); if (l) updateList({ pinned: !l.pinned }); };
  $('colorBtn').onclick = e => { e.stopPropagation(); togglePop($('colorPop'), $('colorBtn')); };
  $('moreBtn').onclick = e => { e.stopPropagation(); togglePop($('morePop'), $('moreBtn')); };
  $('colorPop').onclick = $('morePop').onclick = e => e.stopPropagation();
  document.addEventListener('click', () => { if (!$('colorPop').hidden || !$('morePop').hidden) closePops(); });
  const clearDone = () => {
    const l = activeList(); if (!l) return;
    // A finished task is only cleared if everything nested under it is finished too.
    const d = treeOf(l.id).map(r => r.it).filter(it => it.done && subtreeOf(l.id, it.id).every(s => s.done));
    closePops();
    deleteItems(d, `Cleared ${d.length} completed task${d.length === 1 ? '' : 's'}`);
  };
  $('clearDone').onclick = clearDone; $('clearDoneMenu').onclick = clearDone;
  $('deleteList').onclick = () => { if (S.armedDelete) deleteActiveList(); else { S.armedDelete = true; renderMain(); } };
  $('newList').onclick = () => newList();
  $('signOut').onclick = signOut;
  $('toggleSide').onclick = toggleCompact;
  $('menuBtn').onclick = () => { if (mq.matches) $('app').classList.add('drawer-open'); else toggleCompact(); };
  $('scrim').onclick = closeDrawer;
  $('openSwitcher').onclick = openSwitcher;
  $('switcher').addEventListener('click', e => { if (e.target === $('switcher')) closeSwitcher(); });
  $('swInput').addEventListener('input', () => { S.swIdx = 0; renderSwitcher(); });
  $('swInput').addEventListener('keydown', e => {
    const rows = switcherRows();
    if (e.key === 'ArrowDown') { e.preventDefault(); S.swIdx = Math.min(rows.length - 1, S.swIdx + 1); renderSwitcher(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); S.swIdx = Math.max(0, S.swIdx - 1); renderSwitcher(); }
    else if (e.key === 'Enter') { e.preventDefault(); chooseRow(rows[S.swIdx]); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSwitcher(); }
  });
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) $('kbdK').textContent = '⌘K';

  document.addEventListener('keydown', e => {
    const typing = e.target.closest && e.target.closest('input, textarea, [contenteditable]');
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openSwitcher(); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
      else if (/^Digit[1-9]$/.test(e.code)) { e.preventDefault(); const l = orderedLists()[+e.code.slice(5) - 1]; if (l) setActive(l.id); }
      else if (e.code === 'KeyN') { e.preventDefault(); newList(); }
      else if (e.code === 'KeyS') { e.preventDefault(); toggleCompact(); }
      return;
    }
    if (e.key === 'Escape' && drag) { finishDrag(false); return; }
    if (e.key === 'Escape') { closePops(); closeDrawer(); if (!$('switcher').hidden) closeSwitcher(); return; }
    if (!typing && e.key === '/') { e.preventDefault(); $('addInput').focus(); }
  });

  // Swipe left/right on the panel to move between lists (phone).
  let tx = null, ty = 0;
  $('panel').addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || e.target.closest('input, .grip')) { tx = null; return; }
    tx = e.touches[0].clientX; ty = e.touches[0].clientY;
  }, { passive: true });
  $('panel').addEventListener('touchend', e => {
    if (tx == null) return;
    const t = e.changedTouches[0], dx = t.clientX - tx, dy = t.clientY - ty; tx = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) step(dx < 0 ? 1 : -1);
  }, { passive: true });

  // Phones pause background pages, so catch up when the app comes back.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(true); flush(); } });
  window.addEventListener('online', () => { refresh(true); flush(); });

  mq.addEventListener('change', applyLayout);
  applyLayout();
  render();
  refresh().then(flush);
  connectEvents();
})();
