create or replace function public.server_restore_project(
  p_owner_id uuid,
  p_project_id uuid,
  p_version_id uuid,
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
  receipt private.operation_receipts;
  target public.projects;
  source_version public.project_versions;
  restored public.projects;
  response jsonb;
  operation_name text := 'restore_project:' || p_project_id::text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || operation_name || ':' || p_idempotency_key, 0));
  select * into receipt from private.operation_receipts
  where owner_id = p_owner_id and operation = operation_name and idempotency_key = p_idempotency_key;
  if receipt.id is not null then
    if receipt.request_hash <> p_request_hash then
      raise exception using errcode = '23505', message = 'idempotency key request hash conflict';
    end if;
    if receipt.expires_at <= now() or not exists (
      select 1 from public.projects where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived')
    ) then
      raise exception using errcode = '42501', message = 'restore receipt is not accessible';
    end if;
    return receipt.response_ref;
  end if;
  if not exists (select 1 from public.profiles where id = p_owner_id and status = 'active') then
    raise exception using errcode = '42501', message = 'account is not active';
  end if;
  select * into target from public.projects
  where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived')
  for update;
  if target.id is null then
    raise exception using errcode = '42501', message = 'project is not accessible';
  end if;
  if target.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'project revision conflict';
  end if;
  select * into source_version from public.project_versions
  where id = p_version_id and project_id = p_project_id and owner_id = p_owner_id;
  if source_version.id is null then
    raise exception using errcode = '42501', message = 'project version is not accessible';
  end if;
  update public.projects
  set title = source_version.document ->> 'title',
      platform = (source_version.document ->> 'platform')::public.platform_preset,
      document = source_version.document,
      revision = revision + 1,
      updated_at = now()
  where id = target.id and owner_id = p_owner_id and revision = p_expected_revision
  returning * into restored;
  if restored.id is null then
    raise exception using errcode = '40001', message = 'project revision conflict';
  end if;
  insert into public.project_versions (project_id, owner_id, revision, document, reason)
  values (restored.id, restored.owner_id, restored.revision, restored.document, 'restore');
  response := jsonb_build_object(
    'projectId', restored.id,
    'revision', restored.revision,
    'restoredFromVersionId', source_version.id,
    'httpStatus', 200
  );
  insert into private.operation_receipts (owner_id, operation, idempotency_key, request_hash, status, response_ref)
  values (p_owner_id, operation_name, p_idempotency_key, p_request_hash, 'completed', response);
  return response;
end;
$$;

comment on function public.server_restore_project(uuid, uuid, uuid, bigint, text, text)
is '以项目、所有者和不可变版本三重校验恢复快照，并创建新的 restore 修订版本与幂等回执';
revoke execute on function public.server_restore_project(uuid, uuid, uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function public.server_restore_project(uuid, uuid, uuid, bigint, text, text) to service_role;

notify pgrst, 'reload schema';
