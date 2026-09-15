// Public configuration. Both values are safe to commit: the anon key is meant
// to ship in the browser, and Row Level Security in Postgres is what actually
// protects the data.
//
// Find them in the Supabase dashboard: Project Settings -> API.

export const SUPABASE_URL = 'https://urkarkmwxcygdepvpaps.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_SSWsa7jV62tNdH0IJ-ejfA_pLRh3Oiq';

export function isConfigured() {
  return !SUPABASE_URL.startsWith('REPLACE') && !SUPABASE_ANON_KEY.startsWith('REPLACE');
}
