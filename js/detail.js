// =============================================================================
// Detail side panel: title, type, long-form Markdown body with Write/Preview,
// autosave, metadata, and a warning when someone else edits the same node.
// =============================================================================
import * as store from './store.js';
import * as tree from './tree.js';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12/+esm';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3/+esm';

marked.setOptions({ gfm: true, breaks: true });

const AUTOSAVE_MS = 1000;
const KINDS = ['question', 'finding', 'note'];

let root = null;           // <aside> container
let el = {};               // named child elements
let currentId = null;
let mode = 'write';        // 'write' | 'preview'
let draft = null;          // unsaved body text, null when clean
let saveTimer = null;
let lastSeen = null;       // updated_at of the version we last displayed
let remotePending = null;  // node row from someone else we haven't shown yet

/* ------------------------------------------------------------------------ */
export function mount(aside) {
  root = aside;
  root.innerHTML = `
    <div class="detail-head">
      <input class="detail-title" placeholder="Title" aria-label="Title">
      <select class="detail-kind" aria-label="Type">${KINDS.map(k => `<option value="${k}">${k}</option>`).join('')}</select>
      <button class="detail-close" title="Close (Esc)" aria-label="Close">×</button>
    </div>
    <div class="detail-banner" hidden>
      <span>Someone else changed this item while you were editing.</span>
      <button class="detail-load-remote">Load their version</button>
    </div>
    <div class="detail-tabs">
      <button class="dtab active" data-mode="write">Write</button>
      <button class="dtab" data-mode="preview">Preview</button>
      <span class="detail-save muted"></span>
    </div>
    <textarea class="detail-body" placeholder="Notes, nuance, citations… Markdown is supported: **bold**, *italic*, # headings, - lists, [links](https://…), > quotes."></textarea>
    <div class="detail-preview markdown" hidden></div>
    <div class="detail-meta muted"></div>`;

  el = {
    title: root.querySelector('.detail-title'),
    kind: root.querySelector('.detail-kind'),
    close: root.querySelector('.detail-close'),
    banner: root.querySelector('.detail-banner'),
    loadRemote: root.querySelector('.detail-load-remote'),
    tabs: [...root.querySelectorAll('.dtab')],
    save: root.querySelector('.detail-save'),
    body: root.querySelector('.detail-body'),
    preview: root.querySelector('.detail-preview'),
    meta: root.querySelector('.detail-meta'),
  };

  el.close.onclick = close;
  el.title.onchange = () => { if (currentId) store.setText(currentId, el.title.value); };
  el.title.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); el.title.blur(); el.body.focus(); } };
  el.kind.onchange = () => { if (currentId) store.updateNode(currentId, { kind: el.kind.value }); };
  el.tabs.forEach(t => t.onclick = () => setMode(t.dataset.mode));
  el.body.oninput = () => {
    draft = el.body.value;
    el.save.textContent = 'Unsaved…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, AUTOSAVE_MS);
  };
  el.body.onblur = flush;
  el.loadRemote.onclick = () => {
    if (!remotePending) return;
    draft = null; clearTimeout(saveTimer);
    showNode(remotePending); remotePending = null;
    el.banner.hidden = true;
  };
  root.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  window.addEventListener('beforeunload', flush);

  store.subscribe(onStore);
}

export function open(id) {
  if (!store.get(id)) return;
  if (currentId && currentId !== id) flush();
  currentId = id;
  draft = null; remotePending = null;
  el.banner.hidden = true;
  showNode(store.get(id));
  setMode('write');
  root.hidden = false;
  document.body.classList.add('detail-open');
  tree.setSelected(id);
  el.body.focus();
}

export function close() {
  flush();
  currentId = null; draft = null; remotePending = null;
  root.hidden = true;
  document.body.classList.remove('detail-open');
  tree.setSelected(null);
}

export function isOpen() { return currentId !== null; }

/* ------------------------------------------------------------------------ */
function showNode(n) {
  lastSeen = n.updated_at;
  el.title.value = n.text;
  el.kind.value = n.kind;
  if (draft === null) el.body.value = n.body || '';
  el.save.textContent = draft === null ? '' : 'Unsaved…';
  renderPreview();
  el.meta.innerHTML =
    `Created ${fmt(n.created_at)} by ${esc(store.nameOf(n.created_by))}<br>` +
    `Last edited ${fmt(n.updated_at)} by ${esc(store.nameOf(n.updated_by))}`;
}

function setMode(m) {
  mode = m;
  el.tabs.forEach(t => t.classList.toggle('active', t.dataset.mode === m));
  el.body.hidden = (m !== 'write');
  el.preview.hidden = (m !== 'preview');
  if (m === 'preview') renderPreview(); else el.body.focus();
}

function renderPreview() {
  if (el.preview.hidden) return;
  const src = draft !== null ? draft : (store.get(currentId)?.body || '');
  if (!src.trim()) { el.preview.innerHTML = '<p class="muted"><em>Nothing written yet.</em></p>'; return; }
  el.preview.innerHTML = DOMPurify.sanitize(marked.parse(src));
  el.preview.querySelectorAll('a[href]').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
}

/** Write the draft body to the store if it differs from what's saved. */
function flush() {
  clearTimeout(saveTimer);
  if (currentId === null || draft === null) return;
  const n = store.get(currentId);
  const text = draft; draft = null;
  if (n && text !== (n.body || '')) store.updateNode(currentId, { body: text });
  el.save.textContent = '';
  lastSeen = store.get(currentId)?.updated_at || lastSeen;
}

function onStore(what) {
  if (currentId === null) return;
  if (what === 'nodes' || what === 'reload') {
    const n = store.get(currentId);
    if (!n || store.isTrashed(currentId)) { close(); return; }
    if (n.updated_at === lastSeen) return;
    const mine = n.__optimistic || n.updated_by === store.state.me?.id;
    if (mine) {
      // Our own write coming back: refresh metadata/title/kind, keep any newer draft.
      showNode(n);
    } else if (draft !== null) {
      // Someone else's change while we have unsaved text: don't clobber, warn.
      remotePending = n;
      el.banner.hidden = false;
    } else {
      showNode(n);
    }
  } else if (what === 'profiles') {
    const n = store.get(currentId); if (n) showNode(n);
  }
}

/* ------------------------------------------------------------------------ */
function fmt(iso) { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
