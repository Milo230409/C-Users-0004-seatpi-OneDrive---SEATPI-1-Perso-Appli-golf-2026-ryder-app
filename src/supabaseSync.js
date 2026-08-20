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
    supabase.from("players").select("id,data,updated_at").order("updated_at", { ascending: false }),
    supabase.from("courses").select("id,data,updated_at").order("updated_at", { ascending: false }),
  ]);
  // DÉDUPLICATION : si plusieurs lignes ont le même data.id (doublons cloud d'avant le
  // correctif de synchro), on ne garde que la plus récente (1re en ordre décroissant).
  // Sinon une même partie serait comptée plusieurs fois au classement.
  const dedup = rows => {
    const seen = new Set(), out = [];
    for (const r of (rows || [])) {
      const id = r.data?.id;
      const key = id != null ? `id:${id}` : `row:${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...r.data, _row: r.id });
    }
    return out;
  };
  return {
    games:   dedup(g.data),
    players: dedup(p.data),
    courses: dedup(c.data),
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

// Supprime TOUTES les lignes d'une entité par son data.id (joueurs, parcours…), doublons inclus.
// Robuste : sinon l'entité "revient" au resync (le cloud gardait sa ligne).
export async function deleteEntityByDataId(table, dataId) {
  if (!supabaseEnabled || dataId == null) return;
  const { data } = await supabase.from(table).select("id,data");
  const rows = (data || []).filter(r => String(r.data?.id) === String(dataId));
  for (const r of rows) { await supabase.from(table).delete().eq("id", r.id); }
}

// Supprime TOUTES les lignes d'une partie (par data.id) — suppression définitive et fiable,
// même s'il y a des doublons (sinon la partie « revient » au resync et ses points restent).
// On récupère les lignes puis on supprime par id (clé primaire) = plus robuste qu'un filtre jsonb.
export async function deleteGameByDataId(dataId) {
  if (!supabaseEnabled || dataId == null) return;
  const { data } = await supabase.from("games").select("id,data");
  const rows = (data || []).filter(r => String(r.data?.id) === String(dataId));
  for (const r of rows) { await supabase.from("games").delete().eq("id", r.id); }
}

// Nettoie les doublons de parties dans le cloud (garde la PLUS RÉCENTE par data.id).
// Renvoie le nombre de lignes supprimées.
export async function dedupeGamesCloud() {
  if (!supabaseEnabled) return 0;
  const { data } = await supabase
    .from("games").select("id,data,updated_at").order("updated_at", { ascending: false });
  const seen = new Set(), toDelete = [];
  for (const r of (data || [])) {
    const id = r.data?.id;
    const key = id != null ? `id:${id}` : `row:${r.id}`;
    if (seen.has(key)) toDelete.push(r.id); else seen.add(key);
  }
  for (const rid of toDelete) { await supabase.from("games").delete().eq("id", rid); }
  return toDelete.length;
}

// Supprime TOUTES les parties (repartir à zéro pour une nouvelle saison).
export async function deleteAllGames() {
  if (!supabaseEnabled) return;
  await supabase.from("games").delete().not("id", "is", null);
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
