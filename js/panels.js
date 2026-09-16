// =============================================================================
// Secondary panels: Trash, node History dialog, Admin (user management).
// =============================================================================
import * as store from './store.js';
import { relTime } from './tree.js';

const KINDS = ['question', 'finding', 'note'];

/* ---------------------------------------------------------------- Trash --- */
export function mountTrash(el) {
  store.subscribe((what) => { if (what === 'nodes' || what === 'reload' || what === 'profiles') renderTrash(el); });
  renderTrash(el);
}

function renderTrash(el) {
  const roots = store.trashRoots();
  el.innerHTML = '';
  if (!roots.length) {
    el.innerHTML = '<p class="muted">The trash is empty.</p>';
    return;
  }
  const isAdmin = store.state.me?.role === 'admin';
  const table = document.createElement('table');
  table.className = 'grid';
  table.innerHTML = `<thead><tr><th>Item</th><th>Contains</th><th>Trashed</th><th></th></tr></thead>`;
  const tb = document.createElement('tbody');
  for (const n of roots) {
    const tr = document.createElement('tr');
    const desc = store.descendants(n.id).length;
    tr.innerHTML = `
      <td class="wrap">${esc(n.text) || '<em>Untitled</em>'}</td>
      <td>${desc ? desc + ' sub-item' + (desc === 1 ? '' : 's') : '—'}</td>
      <td title="${new Date(n.deleted_at).toLocaleString()}">${relTime(n.deleted_at)} by ${esc(store.nameOf(n.deleted_by))}</td>
      <td class="nowrap"></td>`;
    const cell = tr.lastElementChild;
    const restore = btn('Restore', () => store.restore(n.id));
    cell.appendChild(restore);
    if (isAdmin) {
      const purge = btn('Delete forever', async () => {
        if (!confirm(`Permanently delete "${n.text || 'Untitled'}"${desc ? ` and its ${desc} sub-items` : ''}? This cannot be undone.`)) return;
        try { await store.purge(n.id); } catch (e) { /* toast shown by store */ }
      }, 'danger');
      cell.appendChild(purge);
    }
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  el.appendChild(table);
}

/* -------------------------------------------------------------- History --- */
let dialog = null;
export function mountHistory(dlg) { dialog = dlg; }

export async function showHistory(nodeId) {
  const n = store.get(nodeId);
  if (!n || !dialog) return;
  const body = dialog.querySelector('.dialog-body');
  dialog.querySelector('.dialog-title').textContent = 'History';
  body.innerHTML = '<p class="muted">Loading…</p>';
  dialog.showModal();

  let rows;
  try { rows = await store.fetchHistory(nodeId); }
  catch (e) { body.innerHTML = `<p class="error">Could not load history: ${esc(e.message)}</p>`; return; }

  body.innerHTML = '';
  const cur = document.createElement('div');
  cur.className = 'version current';
  cur.innerHTML = `<div class="version-head"><strong>Current</strong>
      <span class="muted">edited ${relTime(n.updated_at)} by ${esc(store.nameOf(n.updated_by))} · ${esc(n.kind)}</span></div>
      <div class="version-text">${esc(n.text) || '<em>Untitled</em>'}</div>
      ${(n.body || '').trim() ? `<pre class="version-body">${esc(n.body)}</pre>` : ''}`;
  body.appendChild(cur);

  // Each history row stores the row AS IT WAS BEFORE the change; 'insert' stores
  // the row as created. So each entry is a restorable earlier version.
  const versions = rows.filter(r => r.op !== 'delete');
  if (!versions.length) {
    body.insertAdjacentHTML('beforeend', '<p class="muted">No earlier versions.</p>');
    return;
  }
  for (const r of versions) {
    const d = r.data;
    const what = describeChange(d, n, r);
    const v = document.createElement('div');
    v.className = 'version';
    v.innerHTML = `<div class="version-head">
        <span>${esc(what)}</span>
        <span class="muted" title="${new Date(r.changed_at).toLocaleString()}">${relTime(r.changed_at)} by ${esc(store.nameOf(r.changed_by))}</span>
      </div>
      <div class="version-text">${esc(d.text) || '<em>Untitled</em>'}</div>`;
    if ((d.body || '').trim()) {
      const bodyEl = document.createElement('pre');
      bodyEl.className = 'version-body';
      bodyEl.textContent = d.body;
      v.appendChild(bodyEl);
    }
    const actions = document.createElement('div');
    actions.className = 'version-actions';
    const changed = d.text !== n.text || d.kind !== n.kind || (d.body || '') !== (n.body || '');
    if (changed) {
      actions.appendChild(btn('Restore this version', () => {
        store.updateNode(nodeId, { text: d.text, kind: d.kind, body: d.body || '' });
        dialog.close();
      }));
    }
    v.appendChild(actions);
    body.appendChild(v);
  }
}

function describeChange(prev, cur, row) {
  if (row.op === 'insert') return 'Created';
  // `prev` is the state before the change recorded by this row. Compare with
  // the version after it, which is the next-newer row or the current node.
  return 'Version before edit';
}

/* ---------------------------------------------------------------- Admin --- */
export function mountAdmin(el) {
  store.subscribe((what) => { if (what === 'profiles' || what === 'reload') renderAdmin(el); });
  renderAdmin(el);
}

function renderAdmin(el) {
  const me = store.state.me;
  el.innerHTML = '';
  if (!me || me.role !== 'admin') { el.innerHTML = '<p class="muted">Admins only.</p>'; return; }

  const people = [...store.state.profiles.values()];
  const order = { pending: 0, approved: 1, rejected: 2 };
  people.sort((a, b) => order[a.status] - order[b.status] || a.email.localeCompare(b.email));

  const pending = people.filter(p => p.status === 'pending').length;
  const h = document.createElement('p');
  h.className = 'muted';
  h.textContent = pending ? `${pending} account request${pending === 1 ? '' : 's'} waiting for approval.` : 'No pending requests.';
  el.appendChild(h);

  const table = document.createElement('table');
  table.className = 'grid';
  table.innerHTML = `<thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Role</th><th>Requested</th><th></th></tr></thead>`;
  const tb = document.createElement('tbody');
  for (const p of people) {
    const tr = document.createElement('tr');
    tr.className = 'status-' + p.status;
    tr.innerHTML = `
      <td>${esc(p.display_name)}${p.id === me.id ? ' <span class="muted">(you)</span>' : ''}</td>
      <td>${esc(p.email)}</td>
      <td><span class="pill ${p.status}">${p.status}</span></td>
      <td>${p.role}</td>
      <td title="${new Date(p.created_at).toLocaleString()}">${relTime(p.created_at)}</td>
      <td class="nowrap"></td>`;
    const cell = tr.lastElementChild;
    const act = (label, patch, cls = '') => cell.appendChild(btn(label, async () => {
      try { await store.updateProfile(p.id, patch); } catch (e) { alert(e.message); }
    }, cls));
    if (p.status !== 'approved') act('Approve', { status: 'approved' }, 'primary');
    if (p.status !== 'rejected' && p.id !== me.id) act('Reject', { status: 'rejected' }, 'danger');
    if (p.status === 'approved') {
      if (p.role === 'admin') { if (p.id !== me.id) act('Remove admin', { role: 'editor' }); }
      else act('Make admin', { role: 'admin' });
    }
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  el.appendChild(table);
}

/* ---------------------------------------------------------------- utils --- */
function btn(label, onClick, cls = '') {
  const b = document.createElement('button');
  b.textContent = label; b.className = cls; b.onclick = onClick;
  return b;
}
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export { KINDS };
