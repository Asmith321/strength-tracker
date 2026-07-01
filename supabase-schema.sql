-- Run this once in your Supabase project's SQL Editor
-- (Project → SQL Editor → New query → paste → Run)

create table if not exists kv_store (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Row Level Security: this is a single-user personal app using the
-- public "anon" key, so we allow the anon role full access to this
-- one table only. Nothing else in your Supabase project is exposed.
-- If you ever add other tables, they stay locked down by default.
alter table kv_store enable row level security;

create policy "anon full access to kv_store"
  on kv_store
  for all
  to anon
  using (true)
  with check (true);
