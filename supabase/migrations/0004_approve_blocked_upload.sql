-- ============================================================================
-- Safara — approve_blocked_upload: links a blocked-upload notice's incoming
-- filename to the existing blob, exactly as the pre-feature Tier-1 branch did,
-- and removes the notice. Runs as one transaction with row locks so a
-- concurrent delete of the original blob cannot break the link.
-- ============================================================================

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

  -- Insert the logical file exactly like the old Tier-1 branch, then bump the
  -- ref count the way increment_blob_ref does (atomic update + read back).
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

  return v_new_file.id;
end;
$$;

revoke all on function public.approve_blocked_upload(uuid) from anon, public;
grant execute on function public.approve_blocked_upload(uuid) to authenticated;
