drop function if exists public.server_confirm_recovery_import(uuid, uuid, jsonb);

create or replace function public.server_confirm_recovery_import(
  p_owner_id uuid,
  p_import_id uuid,
  p_inspected_document jsonb,
  p_restored_document jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.recovery_imports;
  created public.projects;
begin
  select * into target from public.recovery_imports
  where id = p_import_id and owner_id = p_owner_id and state = 'inspected'
  for update;
  if target.id is null or target.expires_at <= now() or target.document <> p_inspected_document then
    raise exception using errcode = '42501', message = 'recovery inspection unavailable';
  end if;
  created := private.create_project(
    p_owner_id,
    p_restored_document ->> 'title',
    (p_restored_document ->> 'platform')::public.platform_preset,
    p_restored_document
  );
  update public.recovery_imports set state = 'confirmed' where id = target.id;
  return jsonb_build_object('projectId', created.id, 'revision', created.revision);
end;
$$;

comment on function public.server_confirm_recovery_import(uuid, uuid, jsonb, jsonb)
is '校验同所有者未过期的原始检查快照，并以重写资源标识后的恢复快照创建新项目与版本';
revoke execute on function public.server_confirm_recovery_import(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.server_confirm_recovery_import(uuid, uuid, jsonb, jsonb) to service_role;

notify pgrst, 'reload schema';
