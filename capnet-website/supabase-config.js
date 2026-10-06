/* ============================================================
   CapNet — shared Supabase client
   Loaded on every page (after the Supabase CDN script, before
   the page's own script.js / dashboard.js / faculty.js / admin.js).
   Exposes a single ready-to-use client as `window.capnetDB`.
   ============================================================ */

const SUPABASE_URL = "https://nlysvshpouihjnkoneaa.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_DdRFuQL-NhmoShhXgNRYdg_tiaV1dJn";

window.capnetDB = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
