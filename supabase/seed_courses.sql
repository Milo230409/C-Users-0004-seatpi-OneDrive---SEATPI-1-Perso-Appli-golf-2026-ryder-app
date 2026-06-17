-- ============================================================
--  Du Golf & des Amis — PARCOURS (données RÉELLES, départ jaune)
--  Slope + SSS + HCP de chaque trou relevés sur les cartes de score.
--  À coller dans Supabase → SQL Editor → Run (après schema.sql + open_access.sql).
--  Idempotent : on efface les parcours seed puis on réinsère.
--  → Uniquement les 15 parcours de la liste (les autres sont retirés).
-- ============================================================

delete from public.courses where (data->>'source') is null;

insert into public.courses (data) values
  ('{"id": 1, "name": "Golf Platja de Pals", "country": "Espagne", "par": 73, "si": [16, 8, 14, 4, 6, 18, 2, 10, 12, 5, 17, 1, 13, 7, 15, 9, 3, 11], "tees": [{"name": "Jaune", "cr": 72.0, "slope": 133, "par": 73}]}'::jsonb),
  ('{"id": 2, "name": "Empordà — Forest", "country": "Espagne", "par": 72, "si": [7, 15, 5, 9, 17, 11, 1, 13, 3, 8, 14, 18, 4, 16, 12, 6, 10, 2], "tees": [{"name": "Jaune", "cr": 72.1, "slope": 126, "par": 72}]}'::jsonb),
  ('{"id": 3, "name": "Empordà — Links", "country": "Espagne", "par": 71, "si": [9, 5, 17, 13, 7, 15, 11, 1, 3, 16, 14, 8, 10, 4, 18, 6, 2, 12], "tees": [{"name": "Jaune", "cr": 72.1, "slope": 135, "par": 71}]}'::jsonb),
  ('{"id": 9, "name": "Torremirona Golf Club", "country": "Espagne", "par": 72, "si": [18, 14, 2, 12, 6, 8, 10, 4, 16, 17, 9, 15, 13, 5, 7, 1, 3, 11], "tees": [{"name": "Jaune", "cr": 71.7, "slope": 132, "par": 72}]}'::jsonb),
  ('{"id": 13, "name": "Golf de Marseille La Salette", "country": "France", "par": 71, "si": [11, 12, 17, 14, 6, 8, 3, 9, 5, 13, 4, 18, 2, 15, 16, 1, 10, 7], "tees": [{"name": "Jaune", "cr": 69.0, "slope": 135, "par": 71}]}'::jsonb),
  ('{"id": 14, "name": "Golf de Barbaroux", "country": "France", "par": 72, "si": [7, 9, 11, 17, 1, 3, 13, 15, 5, 12, 16, 4, 8, 14, 18, 6, 2, 10], "tees": [{"name": "Jaune", "cr": 71.4, "slope": 138, "par": 72}]}'::jsonb),
  ('{"id": 15, "name": "Golf International Pont Royal", "country": "France", "par": 72, "si": [7, 13, 3, 9, 11, 15, 5, 1, 17, 12, 4, 8, 10, 18, 2, 16, 6, 14], "tees": [{"name": "Jaune", "cr": 71.7, "slope": 144, "par": 72}]}'::jsonb),
  ('{"id": 16, "name": "Sainte Victoire Golf Club (Château l''Arc)", "country": "France", "par": 72, "si": [15, 10, 16, 5, 4, 18, 13, 17, 6, 14, 8, 2, 1, 11, 7, 9, 3, 12], "tees": [{"name": "Jaune", "cr": 69.6, "slope": 136, "par": 72}]}'::jsonb),
  ('{"id": 17, "name": "Golf Ouest Provence Miramas", "country": "France", "par": 72, "si": [5, 13, 17, 8, 3, 9, 4, 14, 16, 6, 18, 2, 12, 10, 1, 7, 15, 11], "tees": [{"name": "Jaune", "cr": 68.9, "slope": 124, "par": 72}]}'::jsonb),
  ('{"id": 18, "name": "Golf Aix-Marseille (Les Milles)", "country": "France", "par": 72, "si": [5, 8, 14, 4, 13, 3, 15, 17, 7, 6, 18, 9, 11, 10, 2, 12, 1, 16], "tees": [{"name": "Jaune", "cr": 71.6, "slope": 133, "par": 72}]}'::jsonb),
  ('{"id": 19, "name": "Golf Resort Provence Sainte-Baume (Nans)", "country": "France", "par": 72, "si": [14, 5, 8, 16, 1, 3, 2, 12, 6, 11, 15, 10, 18, 7, 9, 17, 4, 13], "tees": [{"name": "Jaune", "cr": 71.0, "slope": 125, "par": 72}]}'::jsonb),
  ('{"id": 20, "name": "Golf de Servanes", "country": "France", "par": 72, "si": [18, 13, 4, 5, 1, 14, 3, 9, 8, 17, 15, 2, 7, 16, 10, 12, 11, 6], "tees": [{"name": "Jaune", "cr": 71.0, "slope": 132, "par": 72}]}'::jsonb),
  ('{"id": 21, "name": "Golf de la Cabre d''Or", "country": "France", "par": 70, "si": [13, 5, 9, 1, 15, 11, 7, 17, 3, 16, 10, 18, 4, 14, 2, 12, 8, 6], "tees": [{"name": "Jaune", "cr": 70.4, "slope": 137, "par": 70}]}'::jsonb),
  ('{"id": 23, "name": "Golf Dolce Frégate Provence", "country": "France", "par": 72, "si": [7, 17, 11, 5, 3, 15, 9, 13, 1, 6, 12, 2, 8, 10, 18, 16, 4, 14], "tees": [{"name": "Jaune", "cr": 70.4, "slope": 126, "par": 72}]}'::jsonb),
  ('{"id": 24, "name": "Golf d''Aix-en-Provence (Rouge)", "country": "France", "par": 70, "si": [9, 16, 8, 7, 17, 1, 18, 6, 15, 2, 3, 14, 5, 10, 4, 12, 11, 13], "tees": [{"name": "Jaune", "cr": 67.2, "slope": 129, "par": 70}]}'::jsonb);

-- Vérif : la liste des parcours
select data->>'name' as parcours, data->>'par' as par,
       (data->'tees'->0->>'slope') as slope_jaune
from public.courses order by parcours;
