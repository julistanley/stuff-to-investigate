// Single shared Supabase client. Loaded from a CDN as an ES module so there is
// no build step. Pinned to major version 2 of supabase-js.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
