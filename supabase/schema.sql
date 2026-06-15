-- ============================================================
--  Du Golf & des Amis — Schéma Supabase (à coller dans SQL Editor)
--  Un seul groupe commun. Inscription libre + email confirmé.
--  Tout utilisateur connecté lit/écrit l'espace partagé du groupe.
-- ============================================================

-- 1) PROFILS  (1 ligne par compte ; créée automatiquement à l'inscription)
create table if not exists public.profiles (
  id        uuid primary key references auth.users(id) on delete cascade,
  name      text,
  nick      text,
  email     text,
  mobile    text,
  index_jeu numeric default 0,           -- index de jeu (handicap)
  created_at timestamptz default now()
);

-- 2) PARCOURS  (base commune éditable par le groupe)
create table if not exists public.courses (
  id         uuid primary key default gen_random_uuid(),
  data       jsonb not null,             -- tout l'objet parcours (tees, pars, si...)
  updated_by uuid references auth.users(id),
  updated_at timestamptz default now()
);

-- 3) JOUEURS du groupe  (la liste des membres, partagée)
create table if not exists public.players (
  id         uuid primary key default gen_random_uuid(),
  data       jsonb not null,             -- {name, nick, index}
  updated_by uuid references auth.users(id),
  updated_at timestamptz default now()
);

-- 4) PARTIES / TOURNOIS  (avec scores, formules, équipes...)
create table if not exists public.games (
  id         uuid primary key default gen_random_uuid(),
  data       jsonb not null,             -- tout l'objet partie (subgames, scores, rounds...)
  done       boolean default false,
  updated_by uuid references auth.users(id),
  updated_at timestamptz default now()
);

-- ============================================================
--  SÉCURITÉ (Row Level Security)
--  Règle simple : il faut être connecté (auth.uid() non nul).
--  Un visiteur sans compte ne peut rien lire ni écrire.
-- ============================================================
alter table public.profiles enable row level security;
alter table public.courses  enable row level security;
alter table public.players  enable row level security;
alter table public.games    enable row level security;

-- PROFILS : chacun lit tous les profils du groupe ; on ne modifie que le sien
drop policy if exists profiles_read   on public.profiles;
drop policy if exists profiles_write  on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_read   on public.profiles for select using ( auth.uid() is not null );
create policy profiles_write  on public.profiles for insert with check ( auth.uid() = id );
create policy profiles_update on public.profiles for update using ( auth.uid() = id );

-- PARCOURS / JOUEURS / PARTIES : tout membre connecté peut lire et écrire le groupe
do $$
declare t text;
begin
  foreach t in array array['courses','players','games']
  loop
    execute format('drop policy if exists %1$s_all on public.%1$s;', t);
    execute format(
      'create policy %1$s_all on public.%1$s for all
         using ( auth.uid() is not null )
         with check ( auth.uid() is not null );', t);
  end loop;
end $$;

-- ============================================================
--  Création automatique du profil à l'inscription
-- ============================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'name',''), new.email)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
--  Realtime (optionnel mais recommandé : MAJ live entre téléphones)
-- ============================================================
alter publication supabase_realtime add table public.games;
alter publication supabase_realtime add table public.players;
alter publication supabase_realtime add table public.courses;
