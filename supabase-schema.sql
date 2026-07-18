-- Run this once in your Supabase project's SQL Editor
-- (Project → SQL Editor → New query → paste → Run)
--
-- This app now uses real Supabase auth: every kv_store row belongs to a
-- user_id, and Row Level Security only lets a signed-in user touch their own
-- rows (auth.uid() = user_id). The public anon key alone can no longer read,
-- modify, or delete any data — a session (email/password login) is required.

create table if not exists kv_store (
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null,
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table kv_store enable row level security;

-- Only the row's owner (the authenticated user) can access it.
create policy "owner rw on kv_store"
  on kv_store
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================================
-- MIGRATING FROM THE OLD OPEN-ACCESS SCHEMA (existing data)
-- If you already had the previous version (key as primary key, anon full
-- access, no user_id), run the steps below INSTEAD of the create above, after
-- you've created your account (Authentication → Users → Add user):
--
--   -- 1. drop the old open policy
--   drop policy if exists "anon full access to kv_store" on kv_store;
--
--   -- 2. add the user_id column
--   alter table kv_store add column if not exists user_id uuid references auth.users (id) on delete cascade;
--
--   -- 3. claim all existing rows for your account
--   --    (replace the email with the one you created)
--   update kv_store set user_id = (select id from auth.users where email = 'you@example.com')
--     where user_id is null;
--
--   -- 4. lock it down
--   alter table kv_store alter column user_id set not null;
--   alter table kv_store drop constraint kv_store_pkey;
--   alter table kv_store add primary key (user_id, key);
--   create policy "owner rw on kv_store" on kv_store for all to authenticated
--     using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- ============================================================================
