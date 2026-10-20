-- Locked In: signup database.
-- Run once in Supabase: SQL Editor -> New query -> paste this file -> Run.
-- Safe to re-run (e.g. after changing the lock time below).

-- Signup deadline. Keep in sync with lockAt in assets/config.js.
create or replace function public.league_lock_at() returns timestamptz
language sql immutable as $$ select '2026-10-23T22:00:00Z'::timestamptz $$;

create or replace function public.int_array_is_distinct(arr integer[]) returns boolean
language sql immutable as $$ select count(distinct x) = count(*) from unnest(arr) as x $$;

create table if not exists public.entries (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  owner_name  text not null check (char_length(btrim(owner_name)) between 1 and 40),
  team_name   text not null check (char_length(btrim(team_name)) between 1 and 40),
  email       text check (email is null or char_length(email) <= 200),
  players     integer[] not null,
  total_cost  integer not null
);

-- Roster size and budget. Keep in sync with rosterSize / budget in assets/config.js;
-- re-running this file updates them on an existing table.
alter table public.entries drop constraint if exists entries_players_check;
alter table public.entries add constraint entries_players_check
  check (cardinality(players) = 15 and public.int_array_is_distinct(players));
alter table public.entries drop constraint if exists entries_total_cost_check;
alter table public.entries add constraint entries_total_cost_check
  check (total_cost between 0 and 750);

create unique index if not exists entries_team_name_key on public.entries (lower(btrim(team_name)));

-- The public (anon) key can only insert, and only before the lock.
-- It can't read the table directly, so emails stay private.
alter table public.entries enable row level security;
revoke all on public.entries from anon, authenticated;
grant insert (owner_name, team_name, email, players, total_cost) on public.entries to anon, authenticated;

drop policy if exists "signups before lock" on public.entries;
create policy "signups before lock" on public.entries
  for insert to anon, authenticated
  with check (now() < public.league_lock_at());

-- Public read for the site: no emails, and rosters stay hidden until the lock.
create or replace function public.league_entries()
returns table (id bigint, created_at timestamptz, owner_name text, team_name text, players integer[], total_cost integer)
language sql stable security definer set search_path = public as $$
  select e.id, e.created_at, e.owner_name, e.team_name,
         case when now() >= public.league_lock_at() then e.players end,
         e.total_cost
  from public.entries e
  order by e.created_at;
$$;
revoke all on function public.league_entries() from public;
grant execute on function public.league_entries() to anon, authenticated;
