// Public configuration. Both values are safe to commit: the anon key is meant
// to ship in the browser, and Row Level Security in Postgres is what actually
// protects the data.
//
// Find them in the Supabase dashboard: Project Settings -> API.

export const SUPABASE_URL = 'REPLACE_WITH_PROJECT_URL';       // e.g. https://abcdefgh.supabase.co
export const SUPABASE_ANON_KEY = 'REPLACE_WITH_ANON_KEY';     // starts with "eyJ" or "sb_publishable_"

export function isConfigured() {
  return !SUPABASE_URL.startsWith('REPLACE') && !SUPABASE_ANON_KEY.startsWith('REPLACE');
}
