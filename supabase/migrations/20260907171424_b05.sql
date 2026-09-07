create or replace function public.server_create_upload_intent(
  p_owner_id uuid, p_kind public.asset_kind, p_purpose public.asset_purpose,
  p_bucket text, p_object_key text, p_mime text, p_bytes bigint, p_sha256 text,
  p_idempotency_key text, p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare receipt private.operation_receipts; created public.assets; response jsonb; operation_name text := 'create_upload_intent';
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || operation_name || ':' || p_idempotency_key, 0));
  select * into receipt from private.operation_receipts
  where owner_id = p_owner_id and operation = operation_name and idempotency_key = p_idempotency_key;
  if receipt.id is not null then
    if receipt.request_hash <> p_request_hash then raise exception using errcode = '23505', message = 'idempotency key request hash conflict'; end if;
    if receipt.expires_at <= now() then raise exception using errcode = '55000', message = 'operation receipt expired'; end if;
    if not exists (
      select 1 from public.assets
      where id = (receipt.response_ref ->> 'assetId')::uuid and owner_id = p_owner_id and state <> 'deleted'
    ) then raise exception using errcode = '42501', message = 'asset is not accessible'; end if;
    return receipt.response_ref;
  end if;
  if p_kind <> 'upload' or p_purpose not in ('source', 'media')
    or p_bucket <> (case when p_purpose = 'source' then 'sources' else 'assets' end)
    or p_bytes <= 0 or p_sha256 !~ '^[0-9a-f]{64}$'
    or p_object_key not like p_owner_id::text || '/%'
    or length(btrim(p_mime)) = 0 then
    raise exception using errcode = '22023', message = 'invalid upload intent';
  end if;
  if not exists (select 1 from public.profiles where id = p_owner_id and status = 'active') then
    raise exception using errcode = '42501', message = 'account is not active';
  end if;
  insert into public.assets (owner_id, kind, purpose, bucket, object_key, mime, bytes, sha256, state)
  values (p_owner_id, p_kind, p_purpose, p_bucket, p_object_key, p_mime, p_bytes, p_sha256, 'pending_upload')
  returning * into created;
  response := jsonb_build_object('assetId', created.id, 'bucket', created.bucket, 'objectKey', created.object_key, 'state', created.state, 'httpStatus', 201);
  insert into private.operation_receipts (owner_id, operation, idempotency_key, request_hash, status, response_ref)
  values (p_owner_id, operation_name, p_idempotency_key, p_request_hash, 'completed', response);
  return response;
end;
$$;
comment on function public.server_create_upload_intent(uuid, public.asset_kind, public.asset_purpose, text, text, text, bigint, text, text, text) is '服务端为直传登记待验证素材与幂等回执的受限入口，对象键强制归属上传者';
revoke execute on function public.server_create_upload_intent(uuid, public.asset_kind, public.asset_purpose, text, text, text, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.server_create_upload_intent(uuid, public.asset_kind, public.asset_purpose, text, text, text, bigint, text, text, text) to service_role;

create or replace function public.server_claim_asset_validation(p_asset_id uuid)
returns setof public.assets
language plpgsql
security definer
set search_path = ''
as $$
declare target public.assets;
begin
  select * into target from public.assets where id = p_asset_id for update;
  if target.id is null or target.state <> 'pending_upload' then return; end if;
  return query update public.assets set state = 'validating', updated_at = now()
    where id = p_asset_id returning *;
end;
$$;
comment on function public.server_claim_asset_validation(uuid) is '验证任务领取待验证素材的受限入口，重复领取返回空集而不是重复工作';
revoke execute on function public.server_claim_asset_validation(uuid) from public, anon, authenticated;
grant execute on function public.server_claim_asset_validation(uuid) to service_role;

create or replace function public.server_finalize_asset_validation(
  p_asset_id uuid, p_ok boolean, p_mime text, p_bytes bigint, p_sha256 text,
  p_width integer, p_height integer, p_duration_ms bigint, p_error_code text
)
returns public.assets
language plpgsql
security definer
set search_path = ''
as $$
declare target public.assets;
begin
  select * into target from public.assets where id = p_asset_id for update;
  if target.id is null then raise exception using errcode = '42501', message = 'asset is not accessible'; end if;
  if target.state in ('ready', 'failed') then return target; end if;
  if target.state <> 'validating' then raise exception using errcode = '42501', message = 'asset is not being validated'; end if;
  if p_ok then
    -- The digest and size were declared before the direct upload started. Refusing to
    -- rewrite them means a file that does not match what the client announced can only
    -- be finalized as failed, never quietly accepted under a corrected digest.
    if p_sha256 is distinct from target.sha256 or p_bytes is distinct from target.bytes then
      raise exception using errcode = '22023', message = 'uploaded object does not match the declared digest';
    end if;
    if length(btrim(coalesce(p_mime, ''))) = 0 then raise exception using errcode = '22023', message = 'validated mime is required'; end if;
    update public.assets
    set state = 'ready', mime = p_mime, width = p_width, height = p_height,
        duration_ms = p_duration_ms, error_code = null, updated_at = now()
    where id = p_asset_id returning * into target;
  else
    if p_error_code !~ '^[A-Z_]{3,40}$' then raise exception using errcode = '22023', message = 'a safe error code is required'; end if;
    update public.assets
    set state = 'failed', error_code = p_error_code, updated_at = now()
    where id = p_asset_id returning * into target;
  end if;
  return target;
end;
$$;
comment on function public.server_finalize_asset_validation(uuid, boolean, text, bigint, text, integer, integer, bigint, text) is '验证任务终结素材状态的受限入口，摘要或大小不符只能判失败不能改写声明值';
revoke execute on function public.server_finalize_asset_validation(uuid, boolean, text, bigint, text, integer, integer, bigint, text) from public, anon, authenticated;
grant execute on function public.server_finalize_asset_validation(uuid, boolean, text, bigint, text, integer, integer, bigint, text) to service_role;

create or replace function public.server_create_url_source(
  p_owner_id uuid, p_metadata jsonb, p_segments jsonb, p_expires_at timestamptz,
  p_idempotency_key text, p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare receipt private.operation_receipts; created public.sources; response jsonb; operation_name text := 'create_url_source';
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || operation_name || ':' || p_idempotency_key, 0));
  select * into receipt from private.operation_receipts
  where owner_id = p_owner_id and operation = operation_name and idempotency_key = p_idempotency_key;
  if receipt.id is not null then
    if receipt.request_hash <> p_request_hash then raise exception using errcode = '23505', message = 'idempotency key request hash conflict'; end if;
    if receipt.expires_at <= now() then raise exception using errcode = '55000', message = 'operation receipt expired'; end if;
    if not exists (
      select 1 from public.sources
      where id = (receipt.response_ref ->> 'sourceId')::uuid and owner_id = p_owner_id
        and state = 'ready' and expires_at > now()
    ) then raise exception using errcode = '42501', message = 'source is not accessible'; end if;
    return receipt.response_ref;
  end if;
  -- A URL source is fetched and parsed inside the short request that creates it, so it
  -- arrives already readable. Empty segments here would be exactly the silent empty
  -- success AC-002 forbids.
  if jsonb_typeof(p_metadata) <> 'object' or jsonb_typeof(p_segments) <> 'array'
    or jsonb_array_length(p_segments) = 0 or p_expires_at <= now()
    or coalesce(p_metadata ->> 'publicUrl', '') !~ '^https://' then
    raise exception using errcode = '22023', message = 'invalid url source';
  end if;
  if not exists (select 1 from public.profiles where id = p_owner_id and status = 'active') then
    raise exception using errcode = '42501', message = 'account is not active';
  end if;
  insert into public.sources (owner_id, kind, metadata, segments, state, expires_at)
  values (p_owner_id, 'url', p_metadata, p_segments, 'ready', p_expires_at) returning * into created;
  response := jsonb_build_object('sourceId', created.id, 'expiresAt', created.expires_at, 'state', created.state, 'httpStatus', 201);
  insert into private.operation_receipts (owner_id, operation, idempotency_key, request_hash, status, response_ref)
  values (p_owner_id, operation_name, p_idempotency_key, p_request_hash, 'completed', response);
  return response;
end;
$$;
comment on function public.server_create_url_source(uuid, jsonb, jsonb, timestamptz, text, text) is '服务端原子保存已抓取解析的公开 URL 来源与幂等回执的受限入口';
revoke execute on function public.server_create_url_source(uuid, jsonb, jsonb, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.server_create_url_source(uuid, jsonb, jsonb, timestamptz, text, text) to service_role;

create or replace function public.server_create_file_source(
  p_owner_id uuid, p_kind public.source_kind, p_asset_id uuid, p_metadata jsonb,
  p_expires_at timestamptz, p_idempotency_key text, p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare receipt private.operation_receipts; created public.sources; response jsonb; operation_name text := 'create_file_source';
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || operation_name || ':' || p_idempotency_key, 0));
  select * into receipt from private.operation_receipts
  where owner_id = p_owner_id and operation = operation_name and idempotency_key = p_idempotency_key;
  if receipt.id is not null then
    if receipt.request_hash <> p_request_hash then raise exception using errcode = '23505', message = 'idempotency key request hash conflict'; end if;
    if receipt.expires_at <= now() then raise exception using errcode = '55000', message = 'operation receipt expired'; end if;
    if not exists (
      select 1 from public.sources
      where id = (receipt.response_ref ->> 'sourceId')::uuid and owner_id = p_owner_id
        and state <> 'deleted' and expires_at > now()
    ) then raise exception using errcode = '42501', message = 'source is not accessible'; end if;
    return receipt.response_ref;
  end if;
  if p_kind not in ('pdf', 'slides', 'video') or jsonb_typeof(p_metadata) <> 'object' or p_expires_at <= now() then
    raise exception using errcode = '22023', message = 'invalid file source';
  end if;
  if not exists (select 1 from public.profiles where id = p_owner_id and status = 'active') then
    raise exception using errcode = '42501', message = 'account is not active';
  end if;
  if not exists (
    select 1 from public.assets
    where id = p_asset_id and owner_id = p_owner_id and purpose = 'source' and state = 'ready'
  ) then raise exception using errcode = '42501', message = 'source file is not available'; end if;
  -- Segments stay empty until a parser finishes, which is why the row opens in parsing
  -- and not in ready: an unparsed file must never look like a usable source.
  insert into public.sources (owner_id, kind, asset_id, metadata, segments, state, expires_at)
  values (p_owner_id, p_kind, p_asset_id, p_metadata, '[]'::jsonb, 'parsing', p_expires_at) returning * into created;
  response := jsonb_build_object('sourceId', created.id, 'expiresAt', created.expires_at, 'state', created.state, 'httpStatus', 202);
  insert into private.operation_receipts (owner_id, operation, idempotency_key, request_hash, status, response_ref)
  values (p_owner_id, operation_name, p_idempotency_key, p_request_hash, 'completed', response);
  return response;
end;
$$;
comment on function public.server_create_file_source(uuid, public.source_kind, uuid, jsonb, timestamptz, text, text) is '服务端为已验证的 PDF、Slides 或 Video 文件登记待解析来源与幂等回执的受限入口';
revoke execute on function public.server_create_file_source(uuid, public.source_kind, uuid, jsonb, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.server_create_file_source(uuid, public.source_kind, uuid, jsonb, timestamptz, text, text) to service_role;

create or replace function public.server_finalize_source_parse(
  p_source_id uuid, p_owner_id uuid, p_segments jsonb, p_metadata jsonb, p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare target public.sources;
begin
  select * into target from public.sources where id = p_source_id and owner_id = p_owner_id for update;
  if target.id is null then raise exception using errcode = '42501', message = 'source is not accessible'; end if;
  if target.state in ('ready', 'failed') then
    return jsonb_build_object('sourceId', target.id, 'state', target.state, 'expiresAt', target.expires_at);
  end if;
  if target.state <> 'parsing' then raise exception using errcode = '42501', message = 'source is not being parsed'; end if;
  if jsonb_typeof(p_metadata) <> 'object' then raise exception using errcode = '22023', message = 'invalid source metadata'; end if;
  if p_error_code is null then
    -- The database refuses the empty success as well, so a parser cannot mark a scan with
    -- no text layer as ready by handing over an empty array.
    if jsonb_typeof(p_segments) <> 'array' or jsonb_array_length(p_segments) = 0 then
      raise exception using errcode = '22023', message = 'a parsed source needs at least one segment';
    end if;
    update public.sources
    set state = 'ready', segments = p_segments, metadata = p_metadata, updated_at = now()
    where id = p_source_id returning * into target;
  else
    if p_error_code !~ '^[A-Z_]{3,40}$' then raise exception using errcode = '22023', message = 'a safe error code is required'; end if;
    -- public.sources carries no error column, so the failure reason rides in metadata.
    -- Only the code goes in; the extracted text never does.
    update public.sources
    set state = 'failed', segments = '[]'::jsonb,
        metadata = p_metadata || jsonb_build_object('errorCode', p_error_code), updated_at = now()
    where id = p_source_id returning * into target;
  end if;
  return jsonb_build_object('sourceId', target.id, 'state', target.state, 'expiresAt', target.expires_at);
end;
$$;
comment on function public.server_finalize_source_parse(uuid, uuid, jsonb, jsonb, text) is '解析任务终结来源状态的受限入口，无段落只能判失败不能标记可用';
revoke execute on function public.server_finalize_source_parse(uuid, uuid, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.server_finalize_source_parse(uuid, uuid, jsonb, jsonb, text) to service_role;

create or replace function public.server_terminate_undispatched_job(p_job_id uuid)
returns public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare target public.jobs;
begin
  select * into target from public.jobs where id = p_job_id for update;
  if target.id is null then raise exception using errcode = '42501', message = 'job is not accessible'; end if;
  if target.state in ('succeeded', 'partial', 'failed', 'canceled') then return target; end if;
  -- Reconciliation cancels the provider run and never touches the row, so a job that was
  -- cancelled before it reached the provider had no path to a terminal state and kept
  -- holding the per-user concurrency slot forever. Only pending_dispatch qualifies:
  -- anything already handed over has a worker holding the lease and must finish through
  -- it. lease_token is passed back as read so the lease check stays real rather than
  -- being bypassed; on a job that was never dispatched it is still null.
  if target.state <> 'pending_dispatch' or target.cancel_requested_at is null then
    raise exception using errcode = '42501', message = 'job was already dispatched or was not cancelled';
  end if;
  return private.finalize_job(
    target.owner_id, target.id, target.lease_token, 'canceled', null, 'CANCELED', 0, 0,
    'job:' || target.id::text || ':cancel-undispatched'
  );
end;
$$;
comment on function public.server_terminate_undispatched_job(uuid) is '终结已请求取消但从未派发的任务并释放额度与成本预留的受限入口';
revoke execute on function public.server_terminate_undispatched_job(uuid) from public, anon, authenticated;
grant execute on function public.server_terminate_undispatched_job(uuid) to service_role;
