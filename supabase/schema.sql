-- RunWay - Supabase schema and row-level security.
--
-- HOW TO APPLY: open your Supabase project, go to SQL Editor, paste this whole
-- file, and run it. Then copy your project URL and anon (public) key from
-- Project Settings - API into RunWay's Settings screen.
--
-- NOT YET VERIFIED AGAINST A LIVE PROJECT. This was written against the
-- documented Supabase/PostgREST behaviour but has not been executed. Run it on a
-- throwaway project first and report any error back.
--
-- The authorisation story: every table has RLS enabled and NO permissive default.
-- The client never filters by user_id itself, so if a policy below is wrong the
-- result is an empty response, not a leak.

-- ============ extensions ============
create extension if not exists "pgcrypto";

-- ============ helper: keep updated_at honest ============
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ============ profiles ============
-- One row per auth user. Created automatically by the trigger below so the app
-- never has to care whether it exists.
create table if not exists public.profiles (
  id                     uuid primary key references auth.users(id) on delete cascade,
  display_name           text not null default 'Runner',
  pace_sec_per_km        integer not null default 330 check (pace_sec_per_km between 120 and 1200),
  weekly_km              numeric not null default 20 check (weekly_km >= 0 and weekly_km <= 400),
  experience             text not null default 'some'
                           check (experience in ('new','returning','some','regular','competitive')),
  preferred_distances    jsonb not null default '[5,10]'::jsonb,
  home_lat               double precision check (home_lat between -90 and 90),
  home_lon              double precision check (home_lon between -180 and 180),
  home_label             text not null default '',
  units                  text not null default 'metric' check (units in ('metric','imperial')),
  prefs                  jsonb not null default '{}'::jsonb,
  activity_privacy       text not null default 'private' check (activity_privacy in ('private','public')),
  route_privacy_default  text not null default 'private' check (route_privacy_default in ('private','public')),
  onboarded              boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- ============ routes ============
-- author_name is denormalised on purpose: the community list can then be a plain
-- select, instead of joining profiles and having to expose whole profile rows.
create table if not exists public.routes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  author_name   text not null default 'Runner',
  name          text not null default 'Untitled route' check (char_length(name) <= 160),
  description   text not null default '' check (char_length(description) <= 4000),
  mode          text not null default 'loop' check (mode in ('loop','oab','p2p')),
  coords        jsonb not null,
  eles          jsonb,
  precise       jsonb,
  stats         jsonb,
  prefs         jsonb,
  start_label   text not null default '',
  end_label     text not null default '',
  is_public     boolean not null default false,
  copied_from   uuid,
  imported_from text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists routes_user_idx   on public.routes (user_id, updated_at desc);
create index if not exists routes_public_idx on public.routes (is_public, updated_at desc) where is_public;

-- ============ activities ============
create table if not exists public.activities (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  route_id            uuid references public.routes(id) on delete set null,
  name                text not null default 'Run',
  distance_m          numeric not null default 0 check (distance_m >= 0),
  duration_s          integer not null default 0 check (duration_s >= 0),
  moving_s            integer not null default 0 check (moving_s >= 0),
  paused_s            integer not null default 0 check (paused_s >= 0),
  avg_pace_sec_per_km numeric,
  ascent_m            numeric,
  track               jsonb,
  started_at          timestamptz,
  finished_at         timestamptz,
  is_public           boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists activities_user_idx on public.activities (user_id, started_at desc);

-- ============ training plans ============
create table if not exists public.plans (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  name              text not null default 'Training plan',
  goal              text not null default 'base',
  target_distance_m numeric,
  race_date         date,
  days_per_week     integer check (days_per_week between 1 and 7),
  weeks             jsonb not null default '[]'::jsonb,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists plans_user_idx on public.plans (user_id, updated_at desc);

-- ============ route feedback ============
create table if not exists public.feedback (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  route_id   uuid not null references public.routes(id) on delete cascade,
  author_name text not null default 'Runner',
  rating     integer check (rating between 1 and 5),
  safety     integer check (safety between 1 and 5),
  scenery    integer check (scenery between 1 and 5),
  surface    integer check (surface between 1 and 5),
  traffic    integer check (traffic between 1 and 5),
  accuracy   integer check (accuracy between 1 and 5),
  comment    text not null default '' check (char_length(comment) <= 2000),
  is_public  boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, route_id)
);
create index if not exists feedback_route_idx on public.feedback (route_id, created_at desc);

-- ============ safety reports ============
-- Public by default: a hazard nobody else can see is not much use. expires_at
-- gives the stale-information review mechanism the brief asks for.
create table if not exists public.safety_reports (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  lat         double precision not null check (lat between -90 and 90),
  lon         double precision not null check (lon between -180 and 180),
  kind        text not null check (kind in
                ('unlit','crossing','surface','traffic','construction','harassment','dog','flooding','other')),
  note        text not null default '' check (char_length(note) <= 1000),
  is_public   boolean not null default true,
  expires_at  timestamptz not null default (now() + interval '180 days'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists safety_geo_idx on public.safety_reports (lat, lon);

-- ============ triggers ============
drop trigger if exists touch_profiles       on public.profiles;
drop trigger if exists touch_routes         on public.routes;
drop trigger if exists touch_activities     on public.activities;
drop trigger if exists touch_plans          on public.plans;
drop trigger if exists touch_feedback       on public.feedback;
drop trigger if exists touch_safety_reports on public.safety_reports;

create trigger touch_profiles       before update on public.profiles       for each row execute function public.touch_updated_at();
create trigger touch_routes         before update on public.routes         for each row execute function public.touch_updated_at();
create trigger touch_activities     before update on public.activities     for each row execute function public.touch_updated_at();
create trigger touch_plans          before update on public.plans          for each row execute function public.touch_updated_at();
create trigger touch_feedback       before update on public.feedback       for each row execute function public.touch_updated_at();
create trigger touch_safety_reports before update on public.safety_reports for each row execute function public.touch_updated_at();

-- create the profile row the moment an account is created
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- ============ row-level security ============
alter table public.profiles       enable row level security;
alter table public.routes         enable row level security;
alter table public.activities     enable row level security;
alter table public.plans          enable row level security;
alter table public.feedback       enable row level security;
alter table public.safety_reports enable row level security;

-- profiles: strictly your own row. No cross-user profile reads at all, which is
-- why author names live on the routes themselves.
drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_select on public.profiles for select using (auth.uid() = id);
create policy profiles_insert on public.profiles for insert with check (auth.uid() = id);
create policy profiles_update on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

-- routes: yours always, other people's only when they published them.
drop policy if exists routes_select on public.routes;
drop policy if exists routes_insert on public.routes;
drop policy if exists routes_update on public.routes;
drop policy if exists routes_delete on public.routes;
create policy routes_select on public.routes for select
  using (auth.uid() = user_id or is_public);
create policy routes_insert on public.routes for insert
  with check (auth.uid() = user_id);
create policy routes_update on public.routes for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy routes_delete on public.routes for delete
  using (auth.uid() = user_id);

-- activities: private by default, independently of route privacy.
drop policy if exists activities_select on public.activities;
drop policy if exists activities_insert on public.activities;
drop policy if exists activities_update on public.activities;
drop policy if exists activities_delete on public.activities;
create policy activities_select on public.activities for select
  using (auth.uid() = user_id or is_public);
create policy activities_insert on public.activities for insert with check (auth.uid() = user_id);
create policy activities_update on public.activities for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy activities_delete on public.activities for delete using (auth.uid() = user_id);

-- plans: never shared.
drop policy if exists plans_select on public.plans;
drop policy if exists plans_insert on public.plans;
drop policy if exists plans_update on public.plans;
drop policy if exists plans_delete on public.plans;
create policy plans_select on public.plans for select using (auth.uid() = user_id);
create policy plans_insert on public.plans for insert with check (auth.uid() = user_id);
create policy plans_update on public.plans for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy plans_delete on public.plans for delete using (auth.uid() = user_id);

-- feedback: your own notes always; other people's only when public AND the route
-- itself is visible to you.
drop policy if exists feedback_select on public.feedback;
drop policy if exists feedback_insert on public.feedback;
drop policy if exists feedback_update on public.feedback;
drop policy if exists feedback_delete on public.feedback;
create policy feedback_select on public.feedback for select
  using (
    auth.uid() = user_id
    or (is_public and exists (
      select 1 from public.routes r
      where r.id = feedback.route_id and (r.is_public or r.user_id = auth.uid())
    ))
  );
create policy feedback_insert on public.feedback for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.routes r
      where r.id = route_id and (r.is_public or r.user_id = auth.uid())
    )
  );
create policy feedback_update on public.feedback for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy feedback_delete on public.feedback for delete using (auth.uid() = user_id);

-- safety reports: public ones are readable by everyone signed in, and stale ones
-- drop out of view automatically.
drop policy if exists safety_select on public.safety_reports;
drop policy if exists safety_insert on public.safety_reports;
drop policy if exists safety_update on public.safety_reports;
drop policy if exists safety_delete on public.safety_reports;
create policy safety_select on public.safety_reports for select
  using (auth.uid() = user_id or (is_public and expires_at > now()));
create policy safety_insert on public.safety_reports for insert with check (auth.uid() = user_id);
create policy safety_update on public.safety_reports for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy safety_delete on public.safety_reports for delete using (auth.uid() = user_id);

-- ============ a note on size ============
-- Route geometry is stored as jsonb. A 30 km route at roughly 5 m spacing is about
-- 150 KB, so the 500 MB free tier holds a few thousand routes. If that ever gets
-- tight, store coords as an encoded polyline string instead of a JSON array.
