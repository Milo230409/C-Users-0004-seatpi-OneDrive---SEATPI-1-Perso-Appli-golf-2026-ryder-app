-- ============================================================
--  Du Golf & des Amis — ACCÈS LIBRE (sans authentification)
--  À coller dans Supabase → SQL Editor → Run.
--  ⚠️ Toute personne ayant le lien peut lire ET écrire ces tables.
--     Choix assumé pour un groupe d'amis fermé.
-- ============================================================

-- On autorise les rôles "anon" (visiteur non connecté) et "authenticated"
-- à tout faire sur les tables du groupe.
do $$
declare t text;
begin
  foreach t in array array['courses','players','games']
  loop
    -- supprime les anciennes policies restrictives
    execute format('drop policy if exists %1$s_all on public.%1$s;', t);
    execute format('drop policy if exists %1$s_anon on public.%1$s;', t);
    -- nouvelle policy : accès total pour tout le monde (anon inclus)
    execute format(
      'create policy %1$s_anon on public.%1$s for all
         to anon, authenticated
         using ( true ) with check ( true );', t);
  end loop;
end $$;

-- Profils : lecture libre, écriture libre (groupe fermé)
drop policy if exists profiles_read   on public.profiles;
drop policy if exists profiles_write  on public.profiles;
drop policy if exists profiles_update on public.profiles;
drop policy if exists profiles_anon   on public.profiles;
create policy profiles_anon on public.profiles for all
  to anon, authenticated using ( true ) with check ( true );

-- Vérif : voir les policies actives
select tablename, policyname, roles from pg_policies
where schemaname='public' order by tablename;
