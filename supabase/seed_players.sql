-- ============================================================
--  Du Golf & des Amis — Liste "Qui es-tu ?" : tes 8 joueurs
--  ------------------------------------------------------------
--  But : pré-créer les 8 noms qui s'affichent sur l'accueil.
--  Chaque joueur, à sa PREMIÈRE connexion, remplit sa fiche une
--  fois pour toutes (surnom, index, mobile, email…).
--  Ensuite, sign-in = SURNOM (affiché, on tape sur son nom) +
--  INDEX de la dernière connexion (le "mot de passe soft").
--  Il pourra saisir un index différent s'il a progressé : ce
--  nouvel index devient la référence pour la fois suivante.
--
--  ORDRE à respecter dans Supabase → SQL Editor → Run :
--    1) schema.sql        (crée les tables)
--    2) open_access.sql   (accès du groupe, sans mot de passe)
--    3) seed_courses.sql  (les 22 parcours)  [optionnel]
--    4) seed_players.sql  (CE fichier)
--
--  👉 Remplace juste les 8 prénoms ci-dessous par ceux à
--     afficher sur l'accueil. NE METS PAS l'index ici : il est
--     saisi dans l'app à la 1re connexion (profileDone reste false).
--  Idempotent : on repart d'une liste propre à chaque exécution.
-- ============================================================

-- On efface les anciens joueurs "seed" pour éviter les doublons
-- (ne touche pas aux joueurs déjà passés en profil complété).
delete from public.players
where (data->>'profileDone') = 'false';

insert into public.players (data) values
  ('{"id":"seed-1","name":"Philippe",    "nick":"", "profileDone":false}'::jsonb),
  ('{"id":"seed-2","name":"Romain",      "nick":"", "profileDone":false}'::jsonb),
  ('{"id":"seed-3","name":"Richard",     "nick":"", "profileDone":false}'::jsonb),
  ('{"id":"seed-4","name":"Jean-Paul",   "nick":"", "profileDone":false}'::jsonb),
  ('{"id":"seed-5","name":"Jean-Pierre", "nick":"", "profileDone":false}'::jsonb),
  ('{"id":"seed-6","name":"Thomas",      "nick":"", "profileDone":false}'::jsonb),
  ('{"id":"seed-7","name":"Nico",        "nick":"", "profileDone":false}'::jsonb),
  ('{"id":"seed-8","name":"Joueur 8",    "nick":"", "profileDone":false}'::jsonb);

-- Vérif : la liste qui s'affichera sur l'accueil
select data->>'name' as nom_affiche, data->>'profileDone' as profil_complet
from public.players
order by nom_affiche;
