-- Golf courses schema for the Ryder app (Supabase / Postgres)
-- Tables: courses -> tees, holes (1-N). Reference data, read by the app.
-- Do NOT hardcode this data in the app: read it from these tables.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- courses
-- ---------------------------------------------------------------------------
create table if not exists public.courses (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  country       text,
  city          text,
  postal_code   text,
  region        text,
  website       text,
  designer      text,
  holes_count   int  not null default 18,
  par           int,
  lat           double precision,
  lng           double precision,
  sources       text[] not null default '{}',
  confidence    text check (confidence in ('haut','moyen','bas')),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- tees (departs) : one row per tee/color of a course
-- ---------------------------------------------------------------------------
create table if not exists public.tees (
  id            uuid primary key default gen_random_uuid(),
  course_id     uuid not null references public.courses(id) on delete cascade,
  name          text not null,
  gender        text check (gender in ('men','ladies','any')),
  length_m      int,
  slope         int,
  course_rating numeric(4,1),
  position      int,
  unique (course_id, name)
);

-- ---------------------------------------------------------------------------
-- holes : one row per hole (1..holes_count) of a course
-- length_m / par / stroke_index can be NULL until filled from the real card.
-- ---------------------------------------------------------------------------
create table if not exists public.holes (
  id            uuid primary key default gen_random_uuid(),
  course_id     uuid not null references public.courses(id) on delete cascade,
  hole_number   int not null check (hole_number between 1 and 18),
  par           int check (par between 3 and 6),
  length_m      int,
  stroke_index  int check (stroke_index between 1 and 18),
  unique (course_id, hole_number)
);

create index if not exists idx_tees_course  on public.tees(course_id);
create index if not exists idx_holes_course on public.holes(course_id);

-- ---------------------------------------------------------------------------
-- Row Level Security: public read, writes reserved to authenticated users.
-- Adjust the write policies to your auth model if needed.
-- ---------------------------------------------------------------------------
alter table public.courses enable row level security;
alter table public.tees    enable row level security;
alter table public.holes   enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='courses' and policyname='courses_read') then
    create policy courses_read on public.courses for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='tees' and policyname='tees_read') then
    create policy tees_read on public.tees for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='holes' and policyname='holes_read') then
    create policy holes_read on public.holes for select using (true);
  end if;

  if not exists (select 1 from pg_policies where tablename='courses' and policyname='courses_write') then
    create policy courses_write on public.courses for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='tees' and policyname='tees_write') then
    create policy tees_write on public.tees for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='holes' and policyname='holes_write') then
    create policy holes_write on public.holes for all to authenticated using (true) with check (true);
  end if;
end $$;
