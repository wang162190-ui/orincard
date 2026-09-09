create or replace function private.duplicate_project(
  p_owner_id uuid,
  p_project_id uuid,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  source public.projects;
  copied public.projects;
  receipt private.operation_receipts;
  response jsonb;
  operation_name constant text := 'duplicate_project';
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || operation_name || ':' || p_idempotency_key, 0));
  select * into receipt from private.operation_receipts
  where owner_id = p_owner_id and operation = operation_name and idempotency_key = p_idempotency_key;
  if receipt.id is not null then
    if receipt.request_hash <> p_request_hash then
      raise exception using errcode = '23505', message = 'idempotency key request hash conflict';
    end if;
    if receipt.expires_at <= now() then
      raise exception using errcode = '55000', message = 'operation receipt expired';
    end if;
    if not exists (
      select 1 from public.projects
      where id = (receipt.response_ref ->> 'projectId')::uuid and owner_id = p_owner_id and state in ('draft', 'archived')
    ) then
      raise exception using errcode = '42501', message = 'project is not accessible';
    end if;
    return receipt.response_ref;
  end if;

  select * into source from public.projects
  where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived') for update;
  if source.id is null then
    raise exception using errcode = '42501', message = 'project is not accessible';
  end if;
  if source.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'project revision conflict';
  end if;

  insert into public.projects (owner_id, title, platform, document, brand_kit_id, state)
  values (
    p_owner_id,
    left(source.title || ' copy', 200),
    source.platform,
    jsonb_set(source.document, '{title}', to_jsonb(left(source.title || ' copy', 200))),
    source.brand_kit_id,
    'draft'
  ) returning * into copied;
  insert into public.project_versions (project_id, owner_id, revision, document, reason)
  values (copied.id, p_owner_id, 1, copied.document, 'manual');
  insert into public.project_asset_refs (project_id, asset_id, slide_id, slot_key)
  select copied.id, asset_id, slide_id, slot_key from public.project_asset_refs where project_id = source.id;

  response := jsonb_build_object('projectId', copied.id, 'revision', copied.revision, 'state', copied.state, 'httpStatus', 201);
  insert into private.operation_receipts (owner_id, operation, idempotency_key, request_hash, status, response_ref)
  values (p_owner_id, operation_name, p_idempotency_key, p_request_hash, 'completed', response);
  return response;
end;
$$;

comment on function private.duplicate_project(uuid, uuid, bigint, text, text)
is '以所有者、修订和幂等回执原子复制项目及其同所有者素材引用，创建独立项目与首个快照';
revoke execute on function private.duplicate_project(uuid, uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function private.duplicate_project(uuid, uuid, bigint, text, text) to service_role;

create or replace function public.server_duplicate_project(
  p_owner_id uuid,
  p_project_id uuid,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language sql
set search_path = ''
as $$
  select private.duplicate_project(p_owner_id, p_project_id, p_expected_revision, p_idempotency_key, p_request_hash);
$$;

comment on function public.server_duplicate_project(uuid, uuid, bigint, text, text)
is '服务端经 Data API 调用项目复制事务的受限入口';
revoke execute on function public.server_duplicate_project(uuid, uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function public.server_duplicate_project(uuid, uuid, bigint, text, text) to service_role;

create or replace function private.archive_project(
  p_owner_id uuid,
  p_project_id uuid,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.projects;
  receipt private.operation_receipts;
  response jsonb;
  operation_name constant text := 'archive_project';
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || operation_name || ':' || p_idempotency_key, 0));
  select * into receipt from private.operation_receipts
  where owner_id = p_owner_id and operation = operation_name and idempotency_key = p_idempotency_key;
  if receipt.id is not null then
    if receipt.request_hash <> p_request_hash then
      raise exception using errcode = '23505', message = 'idempotency key request hash conflict';
    end if;
    if receipt.expires_at <= now() then
      raise exception using errcode = '55000', message = 'operation receipt expired';
    end if;
    if not exists (
      select 1 from public.projects
      where id = p_project_id and owner_id = p_owner_id and state = 'archived'
    ) then
      raise exception using errcode = '42501', message = 'project is not accessible';
    end if;
    return receipt.response_ref;
  end if;

  select * into target from public.projects
  where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived') for update;
  if target.id is null then
    raise exception using errcode = '42501', message = 'project is not accessible';
  end if;
  if target.state <> 'draft' or target.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'project revision conflict';
  end if;
  update public.projects set state = 'archived', revision = revision + 1, updated_at = now()
  where id = target.id returning * into target;
  response := jsonb_build_object('projectId', target.id, 'revision', target.revision, 'state', target.state, 'httpStatus', 200);
  insert into private.operation_receipts (owner_id, operation, idempotency_key, request_hash, status, response_ref)
  values (p_owner_id, operation_name, p_idempotency_key, p_request_hash, 'completed', response);
  return response;
end;
$$;

comment on function private.archive_project(uuid, uuid, bigint, text, text)
is '以所有者、修订和幂等回执原子归档项目；归档后项目及快照保持可读';
revoke execute on function private.archive_project(uuid, uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function private.archive_project(uuid, uuid, bigint, text, text) to service_role;

create or replace function public.server_archive_project(
  p_owner_id uuid,
  p_project_id uuid,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language sql
set search_path = ''
as $$
  select private.archive_project(p_owner_id, p_project_id, p_expected_revision, p_idempotency_key, p_request_hash);
$$;

comment on function public.server_archive_project(uuid, uuid, bigint, text, text)
is '服务端经 Data API 调用项目归档事务的受限入口';
revoke execute on function public.server_archive_project(uuid, uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function public.server_archive_project(uuid, uuid, bigint, text, text) to service_role;

notify pgrst, 'reload schema';
