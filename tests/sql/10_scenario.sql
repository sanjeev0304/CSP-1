-- Behavioral assertions run against the real migration.
-- Run AFTER 00_stubs.sql and the migration, with ON_ERROR_STOP=1.

-- Supabase grants these to authenticated automatically.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'user1@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'user2@example.com');

-- ===========================================================================
-- User 1: one blob, two logical files pointing at it (a Tier-1 hit)
-- ===========================================================================
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- First upload: brand-new blob with a single reference.
insert into public.physical_blobs (user_id, sha256_hash, storage_path, size_bytes, ref_count)
values ('11111111-1111-1111-1111-111111111111', 'deadbeef', '11111111-1111-1111-1111-111111111111/deadbeef', 1000, 1);

do $$
declare b uuid;
begin
  select id into b from public.physical_blobs where sha256_hash = 'deadbeef';
  insert into public.logical_files (user_id, blob_id, filename, filename_stem, extension, size_bytes)
  values ('11111111-1111-1111-1111-111111111111', b, 'Report Final.docx', 'Report Final', 'docx', 1000);
end $$;

select public._t_assert(
  (select ref_count from public.physical_blobs where sha256_hash = 'deadbeef') = 1,
  'new blob starts with ref_count = 1');

-- Second upload of identical bytes: the pipeline's Tier-1 path increments the
-- ref count, then attaches a new logical file to the existing blob.
do $$
declare b uuid;
begin
  select id into b from public.physical_blobs where sha256_hash = 'deadbeef';
  perform public.increment_blob_ref(b);
  insert into public.logical_files (user_id, blob_id, filename, filename_stem, extension, size_bytes)
  values ('11111111-1111-1111-1111-111111111111', b, 'Report-Final copy.docx', 'Report-Final copy', 'docx', 1000);
end $$;

select public._t_assert(
  (select ref_count from public.physical_blobs where sha256_hash = 'deadbeef') = 2,
  'Tier-1 hit incremented ref_count to 2');

select public._t_assert(
  (select count(*) from public.logical_files) = 2,
  'two logical files share a single blob (Tier 1)');

insert into public._t_ids (name, val)
select 'u1_first', id from public.logical_files where filename = 'Report Final.docx';

-- Duplicate (user, hash) must be rejected by the unique constraint.
do $$ begin
  begin
    insert into public.physical_blobs (user_id, sha256_hash, storage_path, size_bytes, ref_count)
    values ('11111111-1111-1111-1111-111111111111', 'deadbeef', 'dup', 1, 1);
    raise exception 'unique constraint missing: duplicate (user_id, sha256_hash) allowed';
  exception when unique_violation then
    raise notice 'PASS: (user_id, sha256_hash) uniqueness enforced within a user';
  end;
end $$;

-- ===========================================================================
-- User 2: the SAME sha256 is allowed, but is a separate physical blob
-- ===========================================================================
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

insert into public.physical_blobs (user_id, sha256_hash, storage_path, size_bytes, ref_count)
values ('22222222-2222-2222-2222-222222222222', 'deadbeef', '22222222-2222-2222-2222-222222222222/deadbeef', 1000, 1);

select public._t_assert(
  (select count(*) from public.physical_blobs) = 1,
  'user 2 sees only their own blob (RLS scoping)');

select public._t_assert(
  (select count(*) from public.logical_files) = 0,
  'user 2 cannot see any of user 1''s logical files');

-- Cross-user insert must be refused by the WITH CHECK policy.
do $$ begin
  begin
    insert into public.logical_files (user_id, blob_id, filename, filename_stem, extension, size_bytes)
    values ('11111111-1111-1111-1111-111111111111',
            (select id from public.physical_blobs limit 1),
            'intruder.docx', 'intruder', 'docx', 1);
    raise exception 'RLS hole: user 2 inserted a row owned by user 1';
  exception when insufficient_privilege then
    raise notice 'PASS: RLS blocked a cross-user insert';
  end;
end $$;

-- Cross-user delete must be refused (even with user 1's real file id).
do $$ begin
  begin
    perform public.delete_logical_file((select val from public._t_ids where name = 'u1_first'));
    raise exception 'RLS hole: user 2 deleted user 1''s file';
  exception when others then
    if sqlerrm like 'RLS hole%' then raise; end if;
    raise notice 'PASS: cross-user delete refused (%)', sqlerrm;
  end;
end $$;

-- ===========================================================================
-- Back to user 1: deletion decrements ref_count, frees the blob only at 0
-- ===========================================================================
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

do $$
declare r jsonb;
begin
  r := public.delete_logical_file((select val from public._t_ids where name = 'u1_first'));
  if (r ->> 'blob_deleted')::boolean is not false then
    raise exception 'first delete removed the blob while a reference remained: %', r;
  end if;
  if (r ->> 'storage_path') is not null then
    raise exception 'storage path returned while the blob still had references';
  end if;
  raise notice 'PASS: first delete keeps the shared blob (blob_deleted=false)';
end $$;

select public._t_assert(
  (select ref_count from public.physical_blobs where sha256_hash = 'deadbeef') = 1,
  'ref_count decremented to 1 after deleting one of two references');

do $$
declare r jsonb;
begin
  r := public.delete_logical_file((select id from public.logical_files limit 1));
  if (r ->> 'blob_deleted')::boolean is not true then
    raise exception 'second delete did not free the blob: %', r;
  end if;
  if (r ->> 'storage_path') is distinct from '11111111-1111-1111-1111-111111111111/deadbeef' then
    raise exception 'expected the storage path back, got %', r ->> 'storage_path';
  end if;
  raise notice 'PASS: second delete frees the blob and returns its storage path';
end $$;

select public._t_assert(
  (select count(*) from public.physical_blobs) = 0,
  'blob row removed once ref_count reached 0');

-- ===========================================================================
-- Document-frequency bump: additive, scoped to the caller
-- ===========================================================================
select public.bump_shingle_doc_frequency(array['111', '222']);
select public.bump_shingle_doc_frequency(array['111']);

select public._t_assert(
  (select doc_count from public.shingle_doc_frequency where shingle_hash = 111) = 2,
  'shared shingle bumped twice');

select public._t_assert(
  (select doc_count from public.shingle_doc_frequency where shingle_hash = 222) = 1,
  'single shingle bumped once');

select public._t_assert(
  (select count(*) from public.shingle_doc_frequency where user_id = '11111111-1111-1111-1111-111111111111') = 2,
  'doc-frequency rows are owned by the caller');

-- User 2 must not see user 1's document frequencies.
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public._t_assert(
  (select count(*) from public.shingle_doc_frequency) = 0,
  'doc frequency is isolated per user');

-- ===========================================================================
-- Final check as superuser: the same hash legitimately exists for two users
-- ===========================================================================
reset role;
select public._t_assert(
  (select count(*) from public.physical_blobs where sha256_hash = 'deadbeef') = 1,
  'after the deletions only user 2''s blob with hash deadbeef remains');

insert into public.physical_blobs (user_id, sha256_hash, storage_path, size_bytes, ref_count)
values ('11111111-1111-1111-1111-111111111111', 'deadbeef', 'again', 1, 1);

select public._t_assert(
  (select count(*) from public.physical_blobs where sha256_hash = 'deadbeef') = 2,
  'the same sha256 coexists across users (per-user uniqueness, not global)');

-- ===========================================================================
-- Blocked uploads & approve_blocked_upload: syncs duplicates into Duplicates tab
-- ===========================================================================
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select public._t_assert(
  public.filename_similarity('report', 'Report') = 1.0,
  'filename_similarity handles case-insensitivity');

select public._t_assert(
  public.filename_similarity('kitten', 'sitting') > 0.57 and public.filename_similarity('kitten', 'sitting') < 0.58,
  'filename_similarity matches Levenshtein distance');

-- Upload an initial file with text and shingles
do $$
declare
  v_blob_id uuid;
  v_file_id uuid;
  v_notice_id uuid;
  v_approved_id uuid;
begin
  select id into v_blob_id from public.physical_blobs
   where user_id = '11111111-1111-1111-1111-111111111111' limit 1;

  insert into public.logical_files
    (user_id, blob_id, filename, filename_stem, extension, size_bytes)
  values
    ('11111111-1111-1111-1111-111111111111', v_blob_id, 'Original Document.docx', 'Original Document', 'docx', 1000)
  returning id into v_file_id;

  insert into public.logical_files_text
    (logical_file_id, user_id, extracted_text, extraction_ok, expected_min_chars, actual_chars, extraction_reason)
  values
    (v_file_id, '11111111-1111-1111-1111-111111111111', 'Sample extracted content of document', true, 300, 37, 'ok');

  insert into public.file_shingles
    (logical_file_id, user_id, shingle_hash, start_offset)
  values
    (v_file_id, '11111111-1111-1111-1111-111111111111', 123456789, 0);

  -- A duplicate upload arrives and is recorded as blocked
  insert into public.blocked_uploads
    (user_id, incoming_filename, sha256_hash, physical_blob_id, filename_stem, extension, size_bytes)
  values
    ('11111111-1111-1111-1111-111111111111', 'Original Document copy.docx', 'deadbeef', v_blob_id, 'Original Document copy', 'docx', 1000)
  returning id into v_notice_id;

  -- User approves the blocked duplicate
  v_approved_id := public.approve_blocked_upload(v_notice_id);

  insert into public._t_ids (name, val) values ('approved_file', v_approved_id);
  insert into public._t_ids (name, val) values ('orig_file', v_file_id);
end $$;

select public._t_assert(
  (select count(*) from public.blocked_uploads where user_id = '11111111-1111-1111-1111-111111111111') = 0,
  'approve_blocked_upload removed notice from blocked_uploads');

select public._t_assert(
  (select count(*) from public.logical_files_text where logical_file_id = (select val from public._t_ids where name = 'approved_file')) = 1,
  'approve_blocked_upload copied logical_files_text to new file');

select public._t_assert(
  (select count(*) from public.file_shingles where logical_file_id = (select val from public._t_ids where name = 'approved_file')) = 1,
  'approve_blocked_upload copied file_shingles to new file');

select public._t_assert(
  (select count(*) from public.near_duplicate_pairs
    where (file_a_id = (select val from public._t_ids where name = 'approved_file')
        or file_b_id = (select val from public._t_ids where name = 'approved_file'))
      and status = 'pending'
      and confidence = 'high'
      and content_score = 1.0) = 1,
  'approve_blocked_upload created pending near_duplicate_pair with content_score=1.0 and high confidence');

reset role;

do $$ begin
  raise notice 'ALL SQL SCENARIO ASSERTIONS PASSED';
end $$;

