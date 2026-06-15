// ============================================================
//  Connexion Supabase — "Du Golf & des Amis"
//  Les clés viennent des variables d'environnement Vite (.env / Vercel).
//  La clé "anon" est PUBLIQUE par conception : aucun risque à l'exposer.
//  Si les clés sont absentes, l'app retombe en mode LOCAL (sans partage).
// ============================================================
import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseEnabled = Boolean(URL && ANON);

export const supabase = supabaseEnabled
  ? createClient(URL, ANON, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;
