// =============================================================================
// List view: renders the hierarchy as nested <ul>s with inline editing.
// Ported from v1; now reads from and writes to the shared store.
// =============================================================================
import * as store from './store.js';

let container = null;
let editingId = null;      // node with an open editor
let draft = null;          // text typed so far in the open editor (survives re-renders)
let pendingFocus = null;   // node id to open an editor on after next render
let onHistory = () => {};  // callback(nodeId) supplied by app.js
let onOpen = () => {};     // callback(nodeId): open the detail panel
let selectedId = null;     // node currently shown in the detail panel

export function setSelected(id) { selectedId = id; render(); }

export function mount(el, opts = {}) {
  container = el;
  onHistory = opts.onHistory || onHistory;
  onOpen = opts.onOpen || onOpen;
  store.subscribe((what) => {
    if (what === 'nodes' || what === 'reload' || what === 'ui') render();
  });
  render();
}

export function addTopLevel() {
  const n = store.createNode({ parentId: null });
  pendingFocus = n.id;
  render();
}

/* ---------------------------------------------------------------------------*/
function render() {
  if (!container) return;
  // Preserve caret if we're re-rendering under an open editor (e.g. realtime).
  let caret = null;
  const openTa = container.querySelector('textarea.editor');
  if (openTa && editingId) caret = [openTa.selectionStart, openTa.selectionEnd];

  const idx = store.childIndex();
  container.innerHTML = '';
  const top = idx.get(null) || [];
  if (top.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-state';
    li.textContent = 'Nothing here yet. Add a top-level item to start the map.';
    container.appendChild(li);
  } else {
    for (const n of top) container.appendChild(renderNode(n, idx));
  }

  if (pendingFocus) {
    const id = pendingFocus; pendingFocus = null;
    startEdit(id);
  } else if (editingId) {
    const ta = editorFor(editingId);
    if (ta) {
      ta.focus();
      if (caret) ta.setSelectionRange(caret[0], caret[1]);
      autosize(ta);
    } else {
      editingId = null; draft = null;   // node vanished (trashed remotely)
    }
  }
}

function renderNode(n, idx) {
  const kids = idx.get(n.id) || [];
  const collapsed = store.isCollapsed(n.id);

  const li = document.createElement('li');
  li.className = 'node';
  li.dataset.id = n.id;

  const row = document.createElement('div');
  row.className = 'row';
  if (n.__optimistic) row.classList.add('saving');
  if (n.id === selectedId) row.classList.add('selected');
  row.ondblclick = (e) => {
    if (e.target.closest('button, select')) return;
    e.preventDefault();
    commitEdit(); render();
    onOpen(n.id);
  };

  const toggle = document.createElement('button');
  toggle.className = 'toggle' + (kids.length ? '' : ' leaf');
  toggle.textContent = collapsed ? '▶' : '▼';
  toggle.title = collapsed ? 'Expand' : 'Collapse';
  toggle.onclick = () => store.toggleCollapsed(n.id);
  row.appendChild(toggle);

  if (editingId === n.id) {
    row.classList.add('editing');
    row.appendChild(buildEditor(n));
  } else {
    const text = document.createElement('div');
    text.className = 'text' + (n.text.trim() ? '' : ' empty');
    text.textContent = n.text.trim() ? n.text : 'Untitled — click to edit';
    text.onclick = () => startEdit(n.id);
    row.appendChild(text);
  }

  if (n.kind && n.kind !== 'question') {
    const k = document.createElement('span');
    k.className = 'kind ' + n.kind;
    k.textContent = n.kind;
    row.appendChild(k);
  }
  if ((n.body || '').trim()) {
    const b = document.createElement('button');
    b.className = 'has-notes';
    b.title = 'Has notes — open details';
    b.textContent = '≡';
    b.onclick = (e) => { e.stopPropagation(); onOpen(n.id); };
    row.appendChild(b);
  }

  if (collapsed && kids.length) {
    const c = document.createElement('span');
    c.className = 'count';
    c.textContent = store.countLive(n.id) + ' hidden';
    row.appendChild(c);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    actionBtn('details', 'Open the full editor (or double-click the row)', () => onOpen(n.id)),
    actionBtn('+ child', 'Add a sub-item under this node', () => {
      const c = store.createNode({ parentId: n.id });
      store.setCollapsed(n.id, false);
      pendingFocus = c.id; render();
    }),
    actionBtn('+ sibling', 'Add an item after this node at the same level', () => {
      const s = store.createNode({ parentId: n.parent_id || null, afterId: n.id });
      pendingFocus = s.id; render();
    }),
    actionBtn('history', 'Show earlier versions of this node', () => onHistory(n.id)),
    actionBtn('trash', 'Move this node and everything under it to the trash', () => {
      const k = store.countLive(n.id);
      const msg = k ? `Move this node and its ${k} descendant${k === 1 ? '' : 's'} to the trash?`
                    : 'Move this node to the trash?';
      if ((n.text.trim() === '' && k === 0) || confirm(msg)) store.trash(n.id);
    }, 'del'),
  );
  row.appendChild(actions);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `edited ${relTime(n.updated_at)} by ${store.nameOf(n.updated_by)}`;
  meta.title = new Date(n.updated_at).toLocaleString();
  row.appendChild(meta);

  li.appendChild(row);

  if (kids.length && !collapsed) {
    const ul = document.createElement('ul');
    for (const k of kids) ul.appendChild(renderNode(k, idx));
    li.appendChild(ul);
  }
  return li;
}

function actionBtn(label, title, onClick, cls = '') {
  const b = document.createElement('button');
  b.textContent = label; b.title = title; b.className = cls;
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

/* ---- inline editing ---- */
function editorFor(id) {
  return container.querySelector(`li[data-id="${id}"] > .row > textarea.editor`);
}

function startEdit(id) {
  if (editingId && editingId !== id) commitEdit();
  if (editingId !== id) { editingId = id; draft = null; }
  render();
  const ta = editorFor(id);
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); autosize(ta); }
}

function buildEditor(n) {
  const ta = document.createElement('textarea');
  ta.className = 'editor';
  ta.rows = 1;
  ta.value = draft !== null ? draft : n.text;
  ta.oninput = () => { draft = ta.value; autosize(ta); };
  ta.onblur = () => {
    // Give click handlers on action buttons a tick to run first.
    setTimeout(() => { if (editingId === n.id && document.activeElement !== ta) { commitEdit(); render(); } }, 0);
  };
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const hadText = ta.value.trim() !== '';
      commitEdit();
      if (hadText) {
        const s = store.createNode({ parentId: n.parent_id || null, afterId: n.id });
        pendingFocus = s.id;
      }
      render();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      editingId = null; draft = null;          // discard changes
      render();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commitEdit();
      e.shiftKey ? store.outdent(n.id) : store.indent(n.id);
      pendingFocus = n.id;
      render();
    }
  };
  return ta;
}

function commitEdit() {
  if (!editingId) return;
  const ta = editorFor(editingId);
  if (ta) store.setText(editingId, ta.value);
  editingId = null; draft = null;
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

/* ---- utils ---- */
export function relTime(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 14) return Math.floor(s / 86400) + ' d ago';
  return new Date(iso).toLocaleDateString();
}
