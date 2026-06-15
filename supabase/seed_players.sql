-- ============================================================
--  Du Golf & des Amis — Amorçage de la liste "Je suis…"
--  8 joueurs de départ, SANS données perso : chacun complétera
--  son profil (prénom, surnom, mobile, email, index, notif) à sa
--  première connexion (formulaire obligatoire dans l'app).
--  À coller dans Supabase → SQL Editor → Run (après open_access.sql).
-- ============================================================

insert into public.players (data) values
  ('{"id":"seed-phil",     "name":"Phil",     "nick":"",        "index":0, "profileDone":false}'::jsonb),
  ('{"id":"seed-rich",     "name":"Rich",     "nick":"",        "index":0, "profileDone":false}'::jsonb),
  ('{"id":"seed-ro",       "name":"Ro",       "nick":"",        "index":0, "profileDone":false}'::jsonb),
  ('{"id":"seed-lena",     "name":"le Na",    "nick":"",        "index":0, "profileDone":false}'::jsonb),
  ('{"id":"seed-jpb",      "name":"jpb",      "nick":"",        "index":0, "profileDone":false}'::jsonb),
  ('{"id":"seed-jpf",      "name":"jpf",      "nick":"",        "index":0, "profileDone":false}'::jsonb),
  ('{"id":"seed-thomas",   "name":"Thomas",   "nick":"",        "index":0, "profileDone":false}'::jsonb),
  ('{"id":"seed-thomasfi", "name":"thomasfi", "nick":"",        "index":0, "profileDone":false}'::jsonb);

-- Vérif
select data->>'name' as nom, data->>'profileDone' as profil_complet
from public.players order by nom;
