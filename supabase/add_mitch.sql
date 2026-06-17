-- ============================================================
--  Ajouter le joueur "Mitch" sans toucher aux autres
--  À coller dans Supabase → SQL Editor → Run (une seule fois).
-- ============================================================
insert into public.players (data)
select '{"id":"seed-9","name":"Mitch","nick":"","profileDone":false}'::jsonb
where not exists (
  select 1 from public.players where data->>'id' = 'seed-9'
);

-- Vérif
select data->>'name' as nom from public.players order by nom;
