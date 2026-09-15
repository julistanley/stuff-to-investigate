// Thin wrappers around Supabase Auth. Every function throws on error so the
// caller can show the message in the UI.
import { supabase } from './db.js';

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

/** fn(event, session). Events of interest: INITIAL_SESSION, SIGNED_IN,
 *  SIGNED_OUT, PASSWORD_RECOVERY, TOKEN_REFRESHED, USER_UPDATED. */
export function onAuthChange(fn) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    // supabase-js asks that callbacks not await other supabase calls directly.
    setTimeout(() => fn(event, session), 0);
  });
  return () => data.subscription.unsubscribe();
}

export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

/** Returns { needsEmailConfirmation } — true when the project still has
 *  "Confirm email" turned on and no session was issued yet. */
export async function signUp(email, password, displayName) {
  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: { data: { display_name: displayName } },
  });
  if (error) throw error;
  return { needsEmailConfirmation: !data.session };
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function sendPasswordReset(email) {
  const redirectTo = location.origin + location.pathname;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
}

export async function updatePassword(password) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}

export async function fetchMyProfile(userId) {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function updateMyDisplayName(userId, displayName) {
  const { data, error } = await supabase.from('profiles')
    .update({ display_name: displayName }).eq('id', userId).select().single();
  if (error) throw error;
  return data;
}
