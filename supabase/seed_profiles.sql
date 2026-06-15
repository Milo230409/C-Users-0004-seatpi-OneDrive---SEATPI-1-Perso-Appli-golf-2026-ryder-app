-- ============================================================
--  Du Golf & des Amis — Profils des amis (scénario "vrais comptes")
--  ORDRE :
--   1) Crée d'abord les comptes dans Supabase :
--      Authentication → Users → Add user → "Create new user"
--      - email de chacun
--      - mot de passe commun : golf2026
--      - COCHER "Auto Confirm User"  (aucun email envoyé)
--   2) Ensuite, lance ce script (SQL Editor → Run) pour remplir les fiches.
--
--  Ce script relie chaque profil à son compte via l'email (auth.users.email),
--  donc tu n'as PAS besoin de copier les UUID à la main.
--  Remplis les valeurs entre < > puis exécute.
-- ============================================================

-- Astuce : on insère/maj le profil en retrouvant l'id du compte par son email.
insert into public.profiles (id, name, nick, email, mobile, index_jeu)
select u.id, v.name, v.nick, v.email, v.mobile, v.index_jeu
from (values
  -- name,            nick,               email,                   mobile,          index
  ('Philippe',       'Phil',             '<email_phil>',          '<tel_phil>',     6),
  ('Romain',         'Rory choux fleur', '<email_romain>',        '<tel_romain>',  12),
  ('Richard',        'Trichatard',       '<email_richard>',       '<tel_richard>', 18),
  ('Jean-Paul',      'Popcorn salé',     '<email_jp>',            '<tel_jp>',       9),
  ('Jean-Pierre',    'Pied fou',         '<email_jp2>',           '<tel_jp2>',     15),
  ('Thomas',         '',                 '<email_thomas>',        '<tel_thomas>',  15),
  ('Nico',           'Le Na',            '<email_nico>',          '<tel_nico>',    25)
) as v(name, nick, email, mobile, index_jeu)
join auth.users u on u.email = v.email
on conflict (id) do update
  set name = excluded.name,
      nick = excluded.nick,
      email = excluded.email,
      mobile = excluded.mobile,
      index_jeu = excluded.index_jeu;

-- Vérif : voir les profils créés
select name, nick, email, mobile, index_jeu from public.profiles order by name;
