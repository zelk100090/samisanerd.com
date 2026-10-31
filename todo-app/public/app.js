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

  // Decides the order tasks appear in within a list.
  // Each item: { id, text, done, order, doneAt, createdAt }. `order` and the
  // timestamps are Date.now() numbers; `doneAt` is null while unchecked.
  function sortItems(items) {
    // TODO(human): return a new sorted array (don't mutate `items`).
    return items.slice().sort((a, b) => a.order - b.order);
  }

  const orderedLists = () => {
    const ls = [...S.lists].sort((a, b) => (a.order || 0) - (b.order || 0));
    return [...ls.filter(l => l.pinned), ...ls.filter(l => !l.pinned)];
  };
  const activeList = () => S.lists.find(l => l.id === S.active) || null;
  const itemsOf = id => S.items.filter(i => i.listId === id);
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
    send([{ op: 'put', kind: 'item', id: newId(), data: { listId: l.id, text, done: false, order: now, createdAt: now, doneAt: null } }]);
  }
  function toggleItem(it) {
    send([{ op: 'put', kind: 'item', id: it.id, data: { done: !it.done, doneAt: it.done ? null : Date.now() } }]);
  }
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
    const its = sortItems(itemsOf(l.id));
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
    if (S.editing) return;
    renderItems(its);
    if (its.length) $('empty').hidden = true; else emptyState();
  }

  const CHECK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const X_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  function renderItems(its) {
    $('items').replaceChildren(...its.map(it => {
      const li = el('li', 'item' + (it.done ? ' done' : '')); li.dataset.id = it.id;
      const c = el('button', 'check'); c.type = 'button'; c.setAttribute('role', 'checkbox');
      c.setAttribute('aria-checked', !!it.done); c.setAttribute('aria-label', it.text); c.innerHTML = CHECK_SVG;
      const d = el('button', 'del'); d.type = 'button'; d.setAttribute('aria-label', 'Delete task'); d.innerHTML = X_SVG;
      li.append(c, el('span', 'text', it.text), d);
      return li;
    }));
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
  function startEdit(li) {
    const it = S.items.find(i => i.id === li.dataset.id); if (!it) return;
    S.editing = it.id;
    const span = li.querySelector('.text');
    const input = el('input', 'edit'); input.value = it.text; input.maxLength = 500; input.setAttribute('aria-label', 'Edit task');
    span.replaceWith(input); input.focus();
    let finished = false;
    const finish = save => {
      if (finished) return; finished = true; S.editing = null;
      const v = input.value.trim();
      if (save && v && v !== it.text) send([{ op: 'put', kind: 'item', id: it.id, data: { text: v } }]);
      else if (save && !v) deleteItems([it], 'Deleted empty task');
      else render();
    };
    input.onkeydown = e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') { e.stopPropagation(); finish(false); } };
    input.onblur = () => finish(true);
  }

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
    const li = e.target.closest('.item'); if (!li) return;
    const it = S.items.find(i => i.id === li.dataset.id); if (!it) return;
    if (e.target.closest('.check')) toggleItem(it);
    else if (e.target.closest('.del')) deleteItems([it], `Deleted “${it.text.length > 32 ? it.text.slice(0, 32) + '…' : it.text}”`);
    else if (e.target.closest('.text')) startEdit(li);
  });
  const title = $('title');
  title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } if (e.key === 'Escape') { const l = activeList(); title.value = l ? l.name : ''; title.blur(); } });
  title.addEventListener('blur', () => { const l = activeList(); const v = title.value.trim(); if (l && v && v !== l.name) updateList({ name: v }); else if (l) title.value = l.name; });
  $('pinBtn').onclick = () => { const l = activeList(); if (l) updateList({ pinned: !l.pinned }); };
  $('colorBtn').onclick = e => { e.stopPropagation(); togglePop($('colorPop'), $('colorBtn')); };
  $('moreBtn').onclick = e => { e.stopPropagation(); togglePop($('morePop'), $('moreBtn')); };
  $('colorPop').onclick = $('morePop').onclick = e => e.stopPropagation();
  document.addEventListener('click', () => { if (!$('colorPop').hidden || !$('morePop').hidden) closePops(); });
  const clearDone = () => { const l = activeList(); if (!l) return; const d = itemsOf(l.id).filter(i => i.done); closePops(); deleteItems(d, `Cleared ${d.length} completed task${d.length === 1 ? '' : 's'}`); };
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
    if (e.key === 'Escape') { closePops(); closeDrawer(); if (!$('switcher').hidden) closeSwitcher(); return; }
    if (!typing && e.key === '/') { e.preventDefault(); $('addInput').focus(); }
  });

  // Swipe left/right on the panel to move between lists (phone).
  let tx = null, ty = 0;
  $('panel').addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || e.target.closest('input')) { tx = null; return; }
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
