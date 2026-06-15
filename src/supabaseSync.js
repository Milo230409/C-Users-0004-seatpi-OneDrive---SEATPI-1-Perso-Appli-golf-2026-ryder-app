// ============================================================
//  Synchronisation des données du groupe avec Supabase
//  Un seul groupe commun : tout le monde lit/écrit les mêmes lignes.
//  Chaque entité (game, player, course) = 1 ligne {id, data:jsonb}.
// ============================================================
import { supabase, supabaseEnabled } from "./supabaseClient";

// ---- lecture initiale du groupe (parties, joueurs, parcours) ----
export async function loadGroup() {
  if (!supabaseEnabled) return null;
  const [g, p, c] = await Promise.all([
    supabase.from("games").select("id,data,done,updated_at").order("updated_at", { ascending: false }),
    supabase.from("players").select("id,data,updated_at"),
    supabase.from("courses").select("id,data,updated_at"),
  ]);
  return {
    games:   (g.data || []).map(r => ({ ...r.data, _row: r.id })),
    players: (p.data || []).map(r => ({ ...r.data, _row: r.id })),
    courses: (c.data || []).map(r => ({ ...r.data, _row: r.id })),
    errors: [g.error, p.error, c.error].filter(Boolean),
  };
}

// ---- upsert d'une entité (renvoie la ligne) ----
export async function upsertEntity(table, obj, userId) {
  if (!supabaseEnabled) return null;
  const row = obj._row || undefined;
  const payload = { ...obj }; delete payload._row;
  const record = { data: payload, updated_by: userId, updated_at: new Date().toISOString() };
  if (row) record.id = row;
  const extra = table === "games" ? { done: !!obj.done } : {};
  const { data, error } = await supabase
    .from(table).upsert({ ...record, ...extra }).select("id").single();
  if (error) { console.error("upsert", table, error); return null; }
  return data?.id;
}

export async function deleteEntity(table, rowId) {
  if (!supabaseEnabled || !rowId) return;
  await supabase.from(table).delete().eq("id", rowId);
}

// ---- profil de l'utilisateur connecté ----
export async function loadMyProfile(userId) {
  if (!supabaseEnabled) return null;
  const { data } = await supabase.from("profiles").select("*").eq("id", userId).single();
  return data || null;
}

export async function saveMyProfile(userId, prof) {
  if (!supabaseEnabled) return;
  await supabase.from("profiles").upsert({
    id: userId, name: prof.name, nick: prof.nick,
    email: prof.email, mobile: prof.mobile, index_jeu: prof.index || 0,
  });
}

// ---- abonnement temps réel (MAJ live entre téléphones) ----
export function subscribeGroup(onChange) {
  if (!supabaseEnabled) return () => {};
  const ch = supabase
    .channel("group-sync")
    .on("postgres_changes", { event: "*", schema: "public", table: "games" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "players" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "courses" }, onChange)
    .subscribe();
  return () => supabase.removeChannel(ch);
}
