-- Konnekt schema updates
-- Run this once in your Supabase project: Dashboard → SQL Editor → New query → paste → Run.
-- It's safe to re-run (all statements are idempotent / guarded with IF NOT EXISTS).

-- 1) Profiles: profile picture, location, username, role, interest tags
alter table public.profiles
  add column if not exists avatar_url text,
  add column if not exists location_text text,
  add column if not exists lat double precision,
  add column if not exists lng double precision,
  add column if not exists username text unique,
  add column if not exists role text,
  add column if not exists tags text[] not null default '{}';

alter table public.profiles
  drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('sponsor','sponsee') or role is null);

-- 2) Listings: tags + non-monetary offers + virtual/remote flag
alter table public.listings
  add column if not exists tags text[] not null default '{}',
  add column if not exists offer_kind text not null default 'money',
  add column if not exists offer_details text,
  add column if not exists is_virtual boolean not null default false;

alter table public.listings
  drop constraint if exists listings_offer_kind_check;
alter table public.listings
  add constraint listings_offer_kind_check check (offer_kind in ('money','other','both'));

-- Budget is now optional (sponsors offering something other than money won't set it)
alter table public.listings alter column budget_min drop not null;
alter table public.listings alter column budget_max drop not null;

-- Contact info is no longer collected when posting — introductions now happen
-- through Connect (messages) and Make an offer (deals) instead.
alter table public.listings alter column contact drop not null;

-- 3) Messages: image attachments + soft delete
alter table public.messages
  add column if not exists image_url text,
  add column if not exists deleted boolean not null default false;

-- Helpful indexes
create index if not exists listings_tags_idx on public.listings using gin (tags);
create index if not exists listings_user_id_idx on public.listings (user_id);
create index if not exists profiles_username_idx on public.profiles (username);

-- 4) Deleting a message requires permission to UPDATE your own rows.
-- If you already have an UPDATE policy on messages, skip this. Otherwise:
drop policy if exists "Users can update own messages" on public.messages;
create policy "Users can update own messages" on public.messages
  for update using (auth.uid() = sender_id);

-- 5) The signup wizard checks username availability before creating an account,
-- which requires public read access on profiles.username. If you don't already
-- have a public SELECT policy on profiles, add one:
drop policy if exists "Public profiles are viewable by everyone" on public.profiles;
create policy "Public profiles are viewable by everyone" on public.profiles
  for select using (true);

-- 6) Verified badge — a manual flag you set yourself (Table Editor → profiles → verified)
-- for whoever you decide to verify. There's no self-serve request flow yet.
alter table public.profiles
  add column if not exists verified boolean not null default false;

-- 7) Deals — structured offers between a sponsor and a team, tied to a listing.
-- One deal thread per (listing, sponsor, team) triple; countering updates the
-- same row and logs the previous terms into `history` rather than creating a new row.
create table if not exists public.deals (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references public.listings(id) on delete set null,
  sponsor_id uuid not null references auth.users(id) on delete cascade,
  team_id uuid not null references auth.users(id) on delete cascade,
  proposed_by uuid not null references auth.users(id),
  turn uuid not null references auth.users(id), -- who needs to act next while status = 'pending'
  status text not null default 'pending' check (status in ('pending','accepted','declined','cancelled','completed')),
  offer_kind text not null default 'money' check (offer_kind in ('money','other','both')),
  amount numeric,
  duration text,
  deliverables text,
  note text,
  sponsor_confirmed boolean not null default false,
  team_confirmed boolean not null default false,
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.deals enable row level security;

drop policy if exists "Participants can view their deals" on public.deals;
create policy "Participants can view their deals" on public.deals
  for select using (auth.uid() = sponsor_id or auth.uid() = team_id);

drop policy if exists "Participants can create deals" on public.deals;
create policy "Participants can create deals" on public.deals
  for insert with check (auth.uid() = sponsor_id or auth.uid() = team_id);

drop policy if exists "Participants can update their deals" on public.deals;
create policy "Participants can update their deals" on public.deals
  for update using (auth.uid() = sponsor_id or auth.uid() = team_id);

create index if not exists deals_sponsor_idx on public.deals (sponsor_id);
create index if not exists deals_team_idx on public.deals (team_id);
create index if not exists deals_listing_idx on public.deals (listing_id);

-- 8) Reviews — left by either side once a deal is completed. One review per
-- reviewer per deal. Publicly readable so they're useful on a profile even to
-- signed-out visitors.
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  reviewer_id uuid not null references auth.users(id) on delete cascade,
  reviewee_id uuid not null references auth.users(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  body text,
  created_at timestamptz not null default now(),
  unique (deal_id, reviewer_id)
);

alter table public.reviews enable row level security;

drop policy if exists "Reviews are publicly viewable" on public.reviews;
create policy "Reviews are publicly viewable" on public.reviews
  for select using (true);

drop policy if exists "Deal participants can leave one review each" on public.reviews;
create policy "Deal participants can leave one review each" on public.reviews
  for insert with check (
    auth.uid() = reviewer_id
    and exists (
      select 1 from public.deals d
      where d.id = deal_id
        and d.status = 'completed'
        and (d.sponsor_id = auth.uid() or d.team_id = auth.uid())
        and reviewee_id in (d.sponsor_id, d.team_id)
        and reviewee_id <> auth.uid()
    )
  );

create index if not exists reviews_reviewee_idx on public.reviews (reviewee_id);
create index if not exists reviews_deal_idx on public.reviews (deal_id);

-- 9) Email match notifications — opt-in flag + a table tracking which
-- (listing, user) pairs have already been emailed, so the notify-matches
-- Edge Function never double-sends. See supabase/functions/notify-matches/.
alter table public.profiles
  add column if not exists notify_matches boolean not null default true;

create table if not exists public.match_notifications (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references public.listings(id) on delete cascade,
  notified_user_id uuid not null references auth.users(id) on delete cascade,
  match_pct int not null,
  created_at timestamptz not null default now(),
  unique (listing_id, notified_user_id)
);

alter table public.match_notifications enable row level security;

drop policy if exists "Users can view their own match notifications" on public.match_notifications;
create policy "Users can view their own match notifications" on public.match_notifications
  for select using (auth.uid() = notified_user_id);
-- No insert/update policy needed here — the Edge Function writes with the
-- service role key, which bypasses RLS entirely.

