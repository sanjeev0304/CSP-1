-- ============================================================================
-- Safara — 0005: sync approved duplicates with Tier-2 text, shingles & pairs
-- When a blocked duplicate is approved via approve_blocked_upload:
-- 1. Copy logical_files_text from an existing file sharing the physical blob.
-- 2. Copy file_shingles and bump shingle_doc_frequency.
-- 3. Insert a pending pair into near_duplicate_pairs so the duplicate
--    immediately appears in the Duplicates tab for comparison and action.
-- 4. Backfill any existing approved duplicate files.
-- ============================================================================

-- Pure-SQL filename Levenshtein similarity to compute filename scores in RPCs.
create or replace function public.filename_similarity(p_a text, p_b text)
returns double precision
language plpgsql
immutable
set search_path = public
as $$
declare
  v_a text := lower(coalesce(p_a, ''));
  v_b text := lower(coalesce(p_b, ''));
  v_m integer := length(v_a);
  v_n integer := length(v_b);
  v_max_len integer;
  v_prev integer[];
  v_curr integer[];
  v_i integer;
  v_j integer;
  v_cost integer;
begin
  if v_a = v_b then
    return 1.0;
  end if;
  v_max_len := greatest(v_m, v_n);
  if v_max_len = 0 then
    return 1.0;
  end if;
  if v_m = 0 or v_n = 0 then
    return 0.0;
  end if;

  for v_j in 0..v_n loop
    v_prev[v_j] := v_j;
  end loop;

  for v_i in 1..v_m loop
    v_curr[0] := v_i;
    for v_j in 1..v_n loop
      if substr(v_a, v_i, 1) = substr(v_b, v_j, 1) then
        v_cost := 0;
      else
        v_cost := 1;
      end if;
      v_curr[v_j] := least(v_prev[v_j] + 1, v_curr[v_j - 1] + 1, v_prev[v_j - 1] + v_cost);
    end loop;
    v_prev := v_curr;
  end loop;

  return 1.0 - (v_prev[v_n]::double precision / v_max_len::double precision);
end;
$$;

grant execute on function public.filename_similarity(text, text) to authenticated;

create or replace function public.approve_blocked_upload(p_notice_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_notice     public.blocked_uploads%rowtype;
  v_blob       public.physical_blobs%rowtype;
  v_new_file   public.logical_files%rowtype;
  v_ref_count  integer;
  v_orig_file  public.logical_files%rowtype;
  v_orig_text  public.logical_files_text%rowtype;
  v_fn_score   double precision;
  v_comp_score double precision;
  v_conf       text;
  v_has_text   boolean := false;
  v_file_a     uuid;
  v_file_b     uuid;
begin
  if auth.uid() is null then
    raise exception 'unauthorized';
  end if;

  -- Own the notice: ownership + FOR UPDATE so two approvals race harmlessly.
  select * into v_notice
    from public.blocked_uploads
   where id = p_notice_id
     and user_id = auth.uid()
   for update;

  if v_notice.id is null then
    raise exception 'notice_not_found';
  end if;

  -- The original may have been deleted while the notice sat in the inbox.
  if v_notice.physical_blob_id is null then
    raise exception 'original_deleted';
  end if;

  -- Lock the blob row FOR UPDATE; a concurrent owner delete blocks here and
  -- the FK/on-delete would then fail this transaction instead of corrupting.
  select * into v_blob
    from public.physical_blobs
   where id = v_notice.physical_blob_id
     and user_id = auth.uid()
   for update;

  if v_blob.id is null then
    raise exception 'original_deleted';
  end if;

  -- Insert the logical file
  insert into public.logical_files
    (user_id, blob_id, filename, filename_stem, extension, size_bytes)
  values
    (auth.uid(), v_blob.id, v_notice.incoming_filename, v_notice.filename_stem,
     v_notice.extension, v_notice.size_bytes)
  returning * into v_new_file;

  update public.physical_blobs
     set ref_count = ref_count + 1
   where id = v_blob.id
  returning ref_count into v_ref_count;

  delete from public.blocked_uploads where id = v_notice.id;

  -- Find the primary existing logical file sharing this blob to copy text metadata
  select lf.* into v_orig_file
    from public.logical_files lf
   where lf.blob_id = v_blob.id
     and lf.id <> v_new_file.id
     and lf.user_id = auth.uid()
   order by lf.uploaded_at asc
   limit 1;

  if v_orig_file.id is not null then
    -- Copy page_count if present on orig file
    if v_orig_file.page_count is not null then
      update public.logical_files
         set page_count = v_orig_file.page_count
       where id = v_new_file.id;
    end if;

    -- Copy logical_files_text if present
    select t.* into v_orig_text
      from public.logical_files_text t
     where t.logical_file_id = v_orig_file.id;

    if v_orig_text.logical_file_id is not null then
      v_has_text := v_orig_text.extraction_ok;
      insert into public.logical_files_text
        (logical_file_id, user_id, extracted_text, extraction_ok, expected_min_chars, actual_chars, extraction_reason)
      values
        (v_new_file.id, auth.uid(), v_orig_text.extracted_text, v_orig_text.extraction_ok,
         v_orig_text.expected_min_chars, v_orig_text.actual_chars, v_orig_text.extraction_reason)
      on conflict (logical_file_id) do nothing;
    end if;

    -- Copy file_shingles if present
    insert into public.file_shingles
      (logical_file_id, user_id, shingle_hash, start_offset)
    select
      v_new_file.id, auth.uid(), s.shingle_hash, s.start_offset
      from public.file_shingles s
     where s.logical_file_id = v_orig_file.id;

    -- Bump shingle doc frequency for the newly shingled copy
    with distinct_hashes as (
      select distinct shingle_hash
        from public.file_shingles
       where logical_file_id = v_new_file.id
    )
    insert into public.shingle_doc_frequency (user_id, shingle_hash, doc_count)
    select auth.uid(), shingle_hash, 1 from distinct_hashes
    on conflict (user_id, shingle_hash)
    do update set doc_count = public.shingle_doc_frequency.doc_count + 1;

    -- For every existing logical file sharing this blob, insert near_duplicate_pair
    for v_orig_file in
      select * from public.logical_files
       where blob_id = v_blob.id
         and id <> v_new_file.id
         and user_id = auth.uid()
    loop
      v_fn_score := public.filename_similarity(v_new_file.filename_stem, v_orig_file.filename_stem);

      if v_has_text then
        v_comp_score := 0.7 * 1.0 + 0.3 * v_fn_score;
        v_conf := 'high';
      else
        v_comp_score := 0.7 * 1.0 + 0.3 * v_fn_score;
        v_conf := 'metadata-only';
      end if;

      if v_new_file.id < v_orig_file.id then
        v_file_a := v_new_file.id;
        v_file_b := v_orig_file.id;
      else
        v_file_a := v_orig_file.id;
        v_file_b := v_new_file.id;
      end if;

      insert into public.near_duplicate_pairs
        (user_id, file_a_id, file_b_id, content_score, filename_score, composite_score, confidence, status)
      values
        (auth.uid(), v_file_a, v_file_b, case when v_has_text then 1.0 else null end,
         v_fn_score, v_comp_score, v_conf, 'pending')
      on conflict (file_a_id, file_b_id) do update set
        content_score = excluded.content_score,
        filename_score = excluded.filename_score,
        composite_score = excluded.composite_score,
        confidence = excluded.confidence,
        status = 'pending';
    end loop;
  end if;

  return v_new_file.id;
end;
$$;

revoke all on function public.approve_blocked_upload(uuid) from anon, public;
grant execute on function public.approve_blocked_upload(uuid) to authenticated;

-- Backfill: sync existing approved duplicate files so they appear in Duplicates tab
-- 1. Copy logical_files_text to any logical_files missing text where a sibling has it
insert into public.logical_files_text
  (logical_file_id, user_id, extracted_text, extraction_ok, expected_min_chars, actual_chars, extraction_reason)
select distinct on (f2.id)
  f2.id, f2.user_id, t.extracted_text, t.extraction_ok, t.expected_min_chars, t.actual_chars, t.extraction_reason
from public.logical_files f2
join public.logical_files f1 on f1.blob_id = f2.blob_id and f1.id <> f2.id
join public.logical_files_text t on t.logical_file_id = f1.id
where not exists (select 1 from public.logical_files_text t2 where t2.logical_file_id = f2.id)
order by f2.id, f1.uploaded_at asc
on conflict (logical_file_id) do nothing;

-- 2. Copy file_shingles to any logical_files missing shingles
insert into public.file_shingles
  (logical_file_id, user_id, shingle_hash, start_offset)
select distinct on (f2.id, s.shingle_hash, s.start_offset)
  f2.id, f2.user_id, s.shingle_hash, s.start_offset
from public.logical_files f2
join public.logical_files f1 on f1.blob_id = f2.blob_id and f1.id <> f2.id
join public.file_shingles s on s.logical_file_id = f1.id
where not exists (select 1 from public.file_shingles s2 where s2.logical_file_id = f2.id)
order by f2.id, s.shingle_hash, s.start_offset, f1.uploaded_at asc;

-- 3. Create missing near_duplicate_pairs for all files sharing the same blob
insert into public.near_duplicate_pairs
  (user_id, file_a_id, file_b_id, content_score, filename_score, composite_score, confidence, status)
select
  f1.user_id,
  least(f1.id, f2.id) as file_a_id,
  greatest(f1.id, f2.id) as file_b_id,
  case when exists (
    select 1 from public.logical_files_text t
     where t.logical_file_id in (f1.id, f2.id) and t.extraction_ok
  ) then 1.0 else null end as content_score,
  public.filename_similarity(f1.filename_stem, f2.filename_stem) as filename_score,
  0.7 * 1.0 + 0.3 * public.filename_similarity(f1.filename_stem, f2.filename_stem) as composite_score,
  case when exists (
    select 1 from public.logical_files_text t
     where t.logical_file_id in (f1.id, f2.id) and t.extraction_ok
  ) then 'high' else 'metadata-only' end as confidence,
  'pending' as status
from public.logical_files f1
join public.logical_files f2 on f1.blob_id = f2.blob_id and f1.id < f2.id
where not exists (
  select 1 from public.near_duplicate_pairs p
   where p.file_a_id = least(f1.id, f2.id) and p.file_b_id = greatest(f1.id, f2.id)
)
on conflict (file_a_id, file_b_id) do nothing;
