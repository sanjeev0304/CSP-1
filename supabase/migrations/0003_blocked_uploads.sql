-- ============================================================================
-- Safara — blocked_uploads: a per-user inbox of exact-duplicate upload
-- attempts. Tier 1 today links a matching SHA-256 to the existing blob; with
-- this feature the attempt is RECORDED instead and can be approved later via
-- approved_blocked_upload, which reproduces the old linking behaviour.
-- ============================================================================

create table if not exists public.blocked_uploads (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  incoming_filename text not null,
  sha256_hash       text not null,
  physical_blob_id  uuid references public.physical_blobs(id) on delete set null,
  -- Mirrors logical_files.filename_stem / extension so approve can rebuild
  -- the logical_files row exactly the way the old Tier-1 branch did.
  filename_stem     text not null,
  extension         text not null,
  size_bytes        bigint not null,
  created_at        timestamptz not null default now(),
  constraint blocked_uploads_user_hash_name_key unique (user_id, sha256_hash, incoming_filename)
);

create index if not exists blocked_uploads_user_created_idx
  on public.blocked_uploads (user_id, created_at desc);

-- Owner-only RLS, same pattern as the other tables.
alter table public.blocked_uploads enable row level security;

drop policy if exists blocked_uploads_owner_all on public.blocked_uploads;
create policy blocked_uploads_owner_all on public.blocked_uploads for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
