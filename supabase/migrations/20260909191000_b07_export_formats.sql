create or replace function public.server_create_exports(
  p_owner_id uuid, p_project_id uuid, p_expected_revision bigint, p_formats text[],
  p_options jsonb, p_confirmed_warnings text[], p_idempotency_key text, p_request_hash text
)
returns table (export_id uuid, job_id uuid, format text)
language plpgsql
security definer
set search_path = ''
as $$
declare receipt private.operation_receipts; target public.projects; version_id uuid; requested text; created_export public.exports;
  created_ids jsonb := '[]'::jsonb; operation_name text := 'create_exports:' || p_project_id::text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || operation_name || ':' || p_idempotency_key, 0));
  select * into receipt from private.operation_receipts where owner_id = p_owner_id and operation = operation_name and idempotency_key = p_idempotency_key;
  if receipt.id is not null then
    if receipt.request_hash <> p_request_hash then raise exception using errcode = '23505', message = 'idempotency key request hash conflict'; end if;
    if receipt.expires_at <= now() or not exists (
      select 1 from public.projects where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived')
    ) then raise exception using errcode = '42501', message = 'export receipt is not accessible'; end if;
    return query
      select exports.id, exports.job_id, exports.format::text from public.exports
      where exports.owner_id = p_owner_id and exports.project_id = p_project_id
        and exports.id in (select (jsonb_array_elements_text(receipt.response_ref -> 'exportIds'))::uuid)
      order by exports.created_at, exports.id;
    return;
  end if;
  if coalesce(array_length(p_formats, 1), 0) < 1 or jsonb_typeof(p_options) <> 'object'
    or exists (select 1 from unnest(p_formats) value where value not in ('png_zip', 'jpg_zip', 'pdf', 'pptx', 'mp4'))
    or (select count(*) from unnest(p_formats)) <> (select count(distinct value) from unnest(p_formats) value) then
    raise exception using errcode = '22023', message = 'invalid export request';
  end if;
  select * into target from public.projects where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived') for update;
  if target.id is null then raise exception using errcode = '42501', message = 'project is not accessible'; end if;
  if target.revision <> p_expected_revision then raise exception using errcode = '40001', message = 'project revision conflict'; end if;
  select id into version_id from public.project_versions
  where project_id = p_project_id and owner_id = p_owner_id and revision = p_expected_revision;
  if version_id is null then raise exception using errcode = '40001', message = 'project version is unavailable'; end if;
  foreach requested in array p_formats loop
    insert into public.jobs (owner_id, project_id, kind, input_ref, idempotency_key, request_hash)
    values (
      p_owner_id, p_project_id, 'export',
      jsonb_build_object('projectVersionId', version_id, 'exportId', gen_random_uuid(), 'format', requested, 'rendererVersion',
        case requested when 'pptx' then 'b07-pptx-v1' when 'mp4' then 'b07-mp4-v1' else 'b04-v1' end),
      p_idempotency_key || ':' || requested, p_request_hash
    ) returning id into job_id;
    insert into public.exports (
      id, owner_id, project_id, project_version_id, job_id, format, options, renderer_version, manifest, state
    ) values (
      (select (input_ref ->> 'exportId')::uuid from public.jobs where id = job_id),
      p_owner_id, p_project_id, version_id, job_id, requested::public.export_format,
      p_options || jsonb_build_object('confirmedWarnings', to_jsonb(p_confirmed_warnings)),
      case requested when 'pptx' then 'b07-pptx-v1' when 'mp4' then 'b07-mp4-v1' else 'b04-v1' end,
      '{}'::jsonb, 'pending'
    ) returning * into created_export;
    created_ids := created_ids || jsonb_build_array(created_export.id);
    export_id := created_export.id; format := created_export.format::text;
    return next;
  end loop;
  insert into private.operation_receipts (owner_id, operation, idempotency_key, request_hash, status, response_ref)
  values (p_owner_id, operation_name, p_idempotency_key, p_request_hash, 'completed', jsonb_build_object('exportIds', created_ids));
end;
$$;

comment on function public.server_create_exports(uuid, uuid, bigint, text[], jsonb, text[], text, text)
is '服务端固定项目快照并为 PNG、JPG、PDF、PPTX 或 MP4 原子创建引用型导出任务与安全回执';
revoke execute on function public.server_create_exports(uuid, uuid, bigint, text[], jsonb, text[], text, text) from public, anon, authenticated;
grant execute on function public.server_create_exports(uuid, uuid, bigint, text[], jsonb, text[], text, text) to service_role;

notify pgrst, 'reload schema';
