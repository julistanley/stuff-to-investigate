// =============================================================================
// App shell: decides which screen to show (setup / sign-in / pending / app),
// wires the header, tabs, toasts, and hands the containers to the views.
// =============================================================================
import { isConfigured } from './config.js';

const $ = (sel) => document.querySelector(sel);
const screens = ['setup', 'auth', 'pending', 'app'];

function showScreen(name) {
  for (const s of screens) $('#screen-' + s).hidden = (s !== name);
}

function toast(msg, kind = 'error', ms = 6000) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function main() {
  if (!isConfigured()) { showScreen('setup'); return; }

  // Loaded lazily so an unconfigured page never tries to build a client.
  const [auth, store, tree, panels] = await Promise.all([
    import('./auth.js'), import('./store.js'), import('./tree.js'), import('./panels.js'),
  ]);

  store.setErrorHandler((e) => toast('Could not save: ' + (e.message || e)));

  /* ---- auth screen ---- */
  const authForms = { signin: $('#form-signin'), signup: $('#form-signup'), forgot: $('#form-forgot'), recovery: $('#form-recovery') };
  function showAuth(which, message = '') {
    showScreen('auth');
    for (const [k, f] of Object.entries(authForms)) f.hidden = (k !== which);
    $('#auth-message').textContent = message;
    $('#auth-message').className = 'auth-message' + (message ? '' : ' hidden');
  }
  document.querySelectorAll('[data-auth]').forEach(a => a.onclick = (e) => { e.preventDefault(); showAuth(a.dataset.auth); });

  const busy = (form, on) => form.querySelectorAll('button, input').forEach(x => x.disabled = on);

  authForms.signin.onsubmit = async (e) => {
    e.preventDefault(); busy(authForms.signin, true);
    try { await auth.signIn(authForms.signin.email.value.trim(), authForms.signin.password.value); }
    catch (err) { showAuth('signin', err.message); }
    finally { busy(authForms.signin, false); }
  };
  authForms.signup.onsubmit = async (e) => {
    e.preventDefault(); busy(authForms.signup, true);
    const f = authForms.signup;
    try {
      const { needsEmailConfirmation } = await auth.signUp(f.email.value.trim(), f.password.value, f.display_name.value.trim());
      if (needsEmailConfirmation) showAuth('signin', 'Check your inbox for a confirmation link, then sign in.');
    } catch (err) { showAuth('signup', err.message); }
    finally { busy(f, false); }
  };
  authForms.forgot.onsubmit = async (e) => {
    e.preventDefault(); busy(authForms.forgot, true);
    try {
      await auth.sendPasswordReset(authForms.forgot.email.value.trim());
      showAuth('signin', 'If that address has an account, a reset link is on its way.');
    } catch (err) { showAuth('forgot', err.message); }
    finally { busy(authForms.forgot, false); }
  };
  authForms.recovery.onsubmit = async (e) => {
    e.preventDefault(); busy(authForms.recovery, true);
    try { await auth.updatePassword(authForms.recovery.password.value); toast('Password updated.', 'ok'); await route(await auth.getSession()); }
    catch (err) { showAuth('recovery', err.message); }
    finally { busy(authForms.recovery, false); }
  };

  /* ---- pending screen ---- */
  let pendingTimer = null;
  function showPending(profile) {
    showScreen('pending');
    $('#pending-email').textContent = profile.email;
    $('#pending-title').textContent = profile.status === 'rejected' ? 'Access declined' : 'Awaiting approval';
    $('#pending-text').textContent = profile.status === 'rejected'
      ? 'An admin has declined this account request. Contact them if you think this is a mistake.'
      : 'Your account has been created. An admin needs to approve it before you can see the map. This page will update automatically once that happens.';
    clearInterval(pendingTimer);
    pendingTimer = setInterval(async () => {
      const s = await auth.getSession(); if (!s) return;
      const p = await auth.fetchMyProfile(s.user.id);
      if (p && p.status === 'approved') { clearInterval(pendingTimer); route(s); }
    }, 15000);
  }
  document.querySelectorAll('.signout').forEach(b => b.onclick = () => auth.signOut());

  /* ---- main app ---- */
  let appStarted = false;
  function startApp(profile) {
    showScreen('app');
    $('#me-name').textContent = profile.display_name;
    $('#tab-admin').hidden = profile.role !== 'admin';
    if (appStarted) return;
    appStarted = true;

    tree.mount($('#tree'), { onHistory: panels.showHistory });
    panels.mountTrash($('#trash'));
    panels.mountAdmin($('#admin'));
    panels.mountHistory($('#history-dialog'));

    $('#addRoot').onclick = () => tree.addTopLevel();
    $('#expandAll').onclick = () => store.expandAll();
    $('#collapseAll').onclick = () => store.collapseAll();
    $('#exportBtn').onclick = () => {
      const blob = new Blob([store.exportJSON()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'stuff-to-investigate-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click(); URL.revokeObjectURL(a.href);
    };
    $('#history-dialog .close').onclick = () => $('#history-dialog').close();

    // tabs
    document.querySelectorAll('.tab').forEach(t => t.onclick = () => selectTab(t.dataset.tab));
    selectTab('map');

    // sync indicator
    const status = $('#status');
    store.subscribe((what) => {
      if (what === 'sync') {
        status.textContent = store.state.pendingWrites ? 'Saving…' : (store.state.lastError ? 'Save failed' : 'All changes saved');
        status.className = 'status' + (store.state.lastError ? ' bad' : '');
      } else if (what.startsWith('realtime:')) {
        const st = what.slice(9);
        $('#live').textContent = st === 'SUBSCRIBED' ? 'live' : 'offline';
        $('#live').title = st === 'SUBSCRIBED' ? 'Other people’s edits appear automatically' : 'Realtime status: ' + st;
        $('#live').className = 'live ' + (st === 'SUBSCRIBED' ? 'on' : 'off');
      } else if (what === 'profiles') {
        const me = store.state.me;
        if (me) {
          $('#tab-admin').hidden = me.role !== 'admin';
          $('#me-name').textContent = me.display_name;
          if (me.status !== 'approved') { store.stopRealtime(); showPending(me); }
        }
        const pend = [...store.state.profiles.values()].filter(p => p.status === 'pending').length;
        $('#pending-count').textContent = pend ? String(pend) : '';
      }
    });
  }
  function selectTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.panel').forEach(p => p.hidden = (p.dataset.panel !== name));
  }

  /* ---- routing on auth state ---- */
  let currentUserId = null;
  async function route(session) {
    clearInterval(pendingTimer);
    if (!session) {
      currentUserId = null; store.stopRealtime(); store.clear(); appStarted = false;
      showAuth('signin'); return;
    }
    let profile;
    try { profile = await auth.fetchMyProfile(session.user.id); }
    catch (e) { showAuth('signin', 'Could not load your profile: ' + e.message); return; }
    if (!profile) { showAuth('signin', 'Your profile is not set up yet. Try signing in again in a moment.'); return; }
    store.state.me = profile;
    if (profile.status !== 'approved') { showPending(profile); return; }
    currentUserId = session.user.id;
    startApp(profile);
    try { await store.loadAll(); } catch (e) { toast('Could not load data: ' + e.message); return; }
    store.startRealtime();
    // profiles are (re)loaded — refresh the pending badge
    const pend = [...store.state.profiles.values()].filter(p => p.status === 'pending').length;
    $('#pending-count').textContent = pend ? String(pend) : '';
  }

  auth.onAuthChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { showAuth('recovery'); return; }
    if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return;   // nothing to re-route
    if (event === 'SIGNED_IN' && session && session.user.id === currentUserId) return; // tab focus echo
    route(session);
  });
}

main().catch(e => { console.error(e); toast('Startup failed: ' + e.message); });
