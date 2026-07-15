
create extension if not exists "pgcrypto";

create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  poster_name text not null,
  type text not null check (type in ('team','sponsor')),
  name text not null,
  category text not null,
  tagline text not null,
  description text not null,
  budget_min integer not null,
  budget_max integer not null,
  contact text not null,
  created_at timestamptz not null default now()
);

alter table public.listings enable row level security;

-- Anyone (including signed-out visitors) can read the board.
create policy "Public read access"
  on public.listings
  for select
  using (true);

-- Only signed-in users can post, and only as themselves.
create policy "Users can insert their own listings"
  on public.listings
  for insert
  with check (auth.uid() = user_id);

-- Only the owner can edit their own listing.
create policy "Users can update their own listings"
  on public.listings
  for update
  using (auth.uid() = user_id);

-- Only the owner can delete their own listing.
create policy "Users can delete their own listings"
  on public.listings
  for delete
  using (auth.uid() = user_id);

-- Helpful index for the board's default sort order.
create index if not exists listings_created_at_idx on public.listings (created_at desc);

-- Enable realtime updates for the board (optional but recommended).
alter publication supabase_realtime add table public.listings;
