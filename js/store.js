// =============================================================================
// Data store
//
// Keeps an in-memory copy of every node and profile, applies edits optimistically
// (UI updates instantly, the database write happens in the background, and the
// change is rolled back with an error toast if the write fails), and listens to
// Supabase Realtime so other people's edits appear live.
//
// Hierarchy: node.parent_id (null = top level) + node.position (fractional
// ordering among siblings). Soft delete: node.deleted_at set on the top node of
// a trashed subtree; descendants are hidden because an ancestor is trashed.
// =============================================================================
import { supabase } from './db.js';

export const state = {
  nodes: new Map(),      // id -> node row
  profiles: new Map(),   // id -> profile row
  me: null,              // my profile row
  loaded: false,
  pendingWrites: 0,
  lastError: null,
};

/* ---- tiny event bus ---- */
const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(what) { for (const fn of listeners) fn(what); }

let errorHandler = (e) => console.error(e);
export function setErrorHandler(fn) { errorHandler = fn; }

/* ---- loading ---- */
export async function loadAll() {
  const [n, p] = await Promise.all([
    supabase.from('nodes').select('*'),
    supabase.from('profiles').select('*'),
  ]);
  if (n.error) throw n.error;
  if (p.error) throw p.error;
  state.nodes = new Map(n.data.map(r => [r.id, r]));
  state.profiles = new Map(p.data.map(r => [r.id, r]));
  state.loaded = true;
  emit('reload');
}

export function clear() {
  state.nodes = new Map(); state.profiles = new Map(); state.me = null; state.loaded = false;
  emit('reload');
}

/* ---- realtime ---- */
let channel = null;
export function startRealtime() {
  if (channel) return;
  channel = supabase.channel('stuff-to-investigate')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'nodes' }, (payload) => {
      if (payload.eventType === 'DELETE') {
        removeSubtreeLocally(payload.old.id);
      } else {
        // Don't let a stale echo overwrite a newer local optimistic edit.
        const local = state.nodes.get(payload.new.id);
        if (local && local.__optimistic && local.updated_at > payload.new.updated_at) return;
        state.nodes.set(payload.new.id, payload.new);
      }
      emit('nodes');
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (payload) => {
      if (payload.eventType === 'DELETE') state.profiles.delete(payload.old.id);
      else {
        state.profiles.set(payload.new.id, payload.new);
        if (state.me && payload.new.id === state.me.id) state.me = payload.new;
      }
      emit('profiles');
    })
    .subscribe((status) => emit('realtime:' + status));
}
export function stopRealtime() {
  if (channel) { supabase.removeChannel(channel); channel = null; }
}

/* ---- derived views ---- */
export function get(id) { return state.nodes.get(id) || null; }
export function nameOf(userId) {
  const p = userId && state.profiles.get(userId);
  return p ? p.display_name : 'unknown';
}

/** True if this node or any ancestor is soft-deleted. */
export function isTrashed(id) {
  let n = state.nodes.get(id);
  const seen = new Set();
  while (n && !seen.has(n.id)) {
    if (n.deleted_at) return true;
    seen.add(n.id);
    n = n.parent_id ? state.nodes.get(n.parent_id) : null;
  }
  return false;
}

function byPosition(a, b) {
  return a.position - b.position || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);
}

/** Map parentId(or null) -> sorted array of live (non-trashed) children.
 *  Built once per render; O(N). */
export function childIndex() {
  const idx = new Map();
  for (const n of state.nodes.values()) {
    if (n.deleted_at) continue;
    const key = n.parent_id || null;
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push(n);
  }
  for (const arr of idx.values()) arr.sort(byPosition);
  // Children of a trashed ancestor are still in idx under their parent, but
  // rendering starts from null and never descends into trashed nodes, so
  // they are naturally invisible.
  return idx;
}

export function liveChildren(parentId) {
  const out = [];
  for (const n of state.nodes.values()) {
    if (!n.deleted_at && (n.parent_id || null) === (parentId || null)) out.push(n);
  }
  return out.sort(byPosition);
}

export function descendants(id) {
  const out = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const n of state.nodes.values()) {
      if (n.parent_id === cur) { out.push(n.id); stack.push(n.id); }
    }
  }
  return out;
}

/** Trashed nodes that are the TOP of their trashed subtree (no trashed ancestor). */
export function trashRoots() {
  const out = [];
  for (const n of state.nodes.values()) {
    if (!n.deleted_at) continue;
    if (n.parent_id && isTrashed(n.parent_id)) continue;
    out.push(n);
  }
  return out.sort((a, b) => (a.deleted_at < b.deleted_at ? 1 : -1));
}

export function countLive(id) {
  let c = 0;
  for (const ch of liveChildren(id)) c += 1 + countLive(ch.id);
  return c;
}

/* ---- position helpers ---- */
function positionAfter(parentId, afterId) {
  const sib = liveChildren(parentId);
  if (!afterId) return sib.length ? sib[sib.length - 1].position + 1 : 0;
  const i = sib.findIndex(s => s.id === afterId);
  if (i < 0) return sib.length ? sib[sib.length - 1].position + 1 : 0;
  const prev = sib[i], next = sib[i + 1];
  return next ? (prev.position + next.position) / 2 : prev.position + 1;
}
function positionLast(parentId) { return positionAfter(parentId, null); }

/* ---- optimistic write machinery ---- */
function beginWrite() { state.pendingWrites++; emit('sync'); }
function endWrite(err) {
  state.pendingWrites--;
  state.lastError = err || null;
  emit('sync');
  if (err) errorHandler(err);
}

function removeSubtreeLocally(id) {
  for (const d of descendants(id)) state.nodes.delete(d);
  state.nodes.delete(id);
}

/**
 * Create a node. Returns the optimistic row synchronously so the UI can focus
 * it immediately; the insert happens in the background.
 */
export function createNode({ parentId = null, afterId = null, text = '', kind = 'question' } = {}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = {
    id, parent_id: parentId, position: positionAfter(parentId, afterId), text, kind,
    created_by: state.me?.id, updated_by: state.me?.id, created_at: now, updated_at: now,
    deleted_at: null, deleted_by: null, __optimistic: true,
  };
  state.nodes.set(id, row);
  emit('nodes');

  beginWrite();
  supabase.from('nodes')
    .insert({ id, parent_id: parentId, position: row.position, text, kind })
    .select().single()
    .then(({ data, error }) => {
      if (error) { state.nodes.delete(id); emit('nodes'); endWrite(error); return; }
      // Keep any text typed since the insert started.
      const cur = state.nodes.get(id);
      state.nodes.set(id, { ...data, ...(cur && cur.__optimistic ? { text: cur.text } : {}) });
      emit('nodes'); endWrite();
    });
  return row;
}

export function updateNode(id, patch) {
  const before = state.nodes.get(id);
  if (!before) return;
  const optimistic = { ...before, ...patch, updated_at: new Date().toISOString(), __optimistic: true };
  state.nodes.set(id, optimistic);
  emit('nodes');

  beginWrite();
  supabase.from('nodes').update(patch).eq('id', id).select().single()
    .then(({ data, error }) => {
      if (error) {
        // Roll back only if nobody has edited it again since.
        if (state.nodes.get(id) === optimistic) { state.nodes.set(id, before); emit('nodes'); }
        endWrite(error); return;
      }
      if (state.nodes.get(id) === optimistic) { state.nodes.set(id, data); emit('nodes'); }
      endWrite();
    });
}

export function setText(id, text) {
  const n = get(id);
  if (n && n.text !== text) updateNode(id, { text });
}

/** Move `id` to be the last child of newParentId. Refuses cycles. */
export function moveToEndOf(id, newParentId) {
  if (newParentId === id || (newParentId && descendants(id).includes(newParentId))) return false;
  updateNode(id, { parent_id: newParentId, position: positionLast(newParentId) });
  return true;
}

/** Move `id` to sit right after `afterId` under `newParentId`. */
export function moveAfter(id, newParentId, afterId) {
  if (newParentId === id || (newParentId && descendants(id).includes(newParentId))) return false;
  updateNode(id, { parent_id: newParentId, position: positionAfter(newParentId, afterId) });
  return true;
}

/** Tab: nest under the previous sibling. */
export function indent(id) {
  const n = get(id); if (!n) return false;
  const sib = liveChildren(n.parent_id);
  const i = sib.findIndex(s => s.id === id);
  if (i <= 0) return false;
  return moveToEndOf(id, sib[i - 1].id);
}

/** Shift+Tab: become a sibling right after the current parent. */
export function outdent(id) {
  const n = get(id); if (!n || !n.parent_id) return false;
  const parent = get(n.parent_id); if (!parent) return false;
  return moveAfter(id, parent.parent_id || null, parent.id);
}

export function trash(id) { updateNode(id, { deleted_at: new Date().toISOString() }); }

export function restore(id) {
  const n = get(id); if (!n) return;
  const patch = { deleted_at: null };
  // If the original parent is (still) in the trash, surface at top level.
  if (n.parent_id && isTrashed(n.parent_id)) { patch.parent_id = null; patch.position = positionLast(null); }
  updateNode(id, patch);
}

/** Admin only. Permanently deletes a trashed node and (via DB cascade) its subtree. */
export async function purge(id) {
  beginWrite();
  const { error } = await supabase.from('nodes').delete().eq('id', id);
  if (error) { endWrite(error); throw error; }
  removeSubtreeLocally(id);
  emit('nodes'); endWrite();
}

/* ---- history ---- */
export async function fetchHistory(nodeId) {
  const { data, error } = await supabase.from('node_history').select('*')
    .eq('node_id', nodeId).order('changed_at', { ascending: false }).limit(200);
  if (error) throw error;
  return data;
}

/* ---- profiles (admin) ---- */
export async function updateProfile(id, patch) {
  const { data, error } = await supabase.from('profiles').update(patch).eq('id', id).select().single();
  if (error) throw error;
  state.profiles.set(id, data);
  if (state.me && id === state.me.id) state.me = data;
  emit('profiles');
  return data;
}

/* ---- per-browser UI state: which nodes are collapsed ---- */
const COLLAPSE_KEY = 'stuff-to-investigate:collapsed';
let collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'));
function persistCollapsed() { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed])); }
export function isCollapsed(id) { return collapsed.has(id); }
export function setCollapsed(id, v) { v ? collapsed.add(id) : collapsed.delete(id); persistCollapsed(); emit('ui'); }
export function toggleCollapsed(id) { setCollapsed(id, !collapsed.has(id)); }
export function collapseAll() {
  collapsed = new Set([...state.nodes.values()].filter(n => liveChildren(n.id).length).map(n => n.id));
  persistCollapsed(); emit('ui');
}
export function expandAll() { collapsed = new Set(); persistCollapsed(); emit('ui'); }

/* ---- export ---- */
export function exportJSON() {
  const nodes = [...state.nodes.values()].map(({ __optimistic, ...n }) => n);
  return JSON.stringify({ exported_at: new Date().toISOString(), format: 'stuff-to-investigate/v2', nodes }, null, 2);
}
