-- T059 staged project and account deletion.
do $$
begin
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'deletion_scope') then
    create type public.deletion_scope as enum ('project', 'account');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'deletion_state') then
    create type public.deletion_state as enum ('pending', 'running', 'completed', 'failed');
  end if;
end
$$;

comment on type public.deletion_scope is '异步清理针对单个项目或整个账户';
comment on type public.deletion_state is '分阶段删除清理任务状态';

alter table public.assets add column if not exists deleted_at timestamptz;
comment on column public.assets.deleted_at is '物理对象删除完成时间（UTC）';

create table if not exists public.deletion_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete restrict,
  scope public.deletion_scope not null,
  project_id uuid references public.projects (id) on delete restrict,
  state public.deletion_state not null default 'pending',
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint deletion_requests_target_check check ((scope = 'project' and project_id is not null) or (scope = 'account' and project_id is null)),
  constraint deletion_requests_completion_check check ((state = 'completed' and completed_at is not null) or (state <> 'completed' and completed_at is null))
);

comment on table public.deletion_requests is '权限立即切断后由后台执行的物理清理请求';
comment on column public.deletion_requests.id is '删除请求唯一标识';
comment on column public.deletion_requests.owner_id is '删除请求账户所有者';
comment on column public.deletion_requests.scope is '项目或账户删除范围';
comment on column public.deletion_requests.project_id is '项目删除时的目标项目';
comment on column public.deletion_requests.state is '后台清理执行状态';
comment on column public.deletion_requests.error_code is '可重试清理的安全错误码';
comment on column public.deletion_requests.created_at is '权限切断时间（UTC）';
comment on column public.deletion_requests.updated_at is '最近状态更新时间（UTC）';
comment on column public.deletion_requests.completed_at is '物理清理完成时间（UTC）';

create unique index if not exists deletion_requests_open_project_idx on public.deletion_requests (project_id) where project_id is not null and state in ('pending', 'running');
create unique index if not exists deletion_requests_open_account_idx on public.deletion_requests (owner_id) where scope = 'account' and state in ('pending', 'running');

create or replace function public.server_request_project_deletion(p_owner_id uuid, p_project_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare request_id uuid;
begin
  update public.projects set state = 'deleting', deleted_at = coalesce(deleted_at, now()), updated_at = now()
  where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived');
  if not found then raise exception using errcode = '42501', message = 'project is not accessible'; end if;
  update public.jobs set cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now()
  where owner_id = p_owner_id and project_id = p_project_id and state not in ('succeeded', 'partial', 'failed', 'canceled');
  insert into public.deletion_requests (owner_id, scope, project_id) values (p_owner_id, 'project', p_project_id) returning id into request_id;
  return request_id;
end;
$$;
comment on function public.server_request_project_deletion(uuid, uuid) is '按所有者原子切断项目授权、请求运行中任务取消并登记后台清理';
revoke execute on function public.server_request_project_deletion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.server_request_project_deletion(uuid, uuid) to service_role;

create or replace function public.server_request_account_deletion(p_owner_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare request_id uuid;
begin
  update public.profiles set status = 'deleting' where id = p_owner_id and status = 'active';
  if not found then raise exception using errcode = '42501', message = 'account is not accessible'; end if;
  update public.projects set state = 'deleting', deleted_at = coalesce(deleted_at, now()), updated_at = now()
  where owner_id = p_owner_id and state in ('draft', 'archived');
  update public.jobs set cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now()
  where owner_id = p_owner_id and state not in ('succeeded', 'partial', 'failed', 'canceled');
  insert into public.deletion_requests (owner_id, scope) values (p_owner_id, 'account') returning id into request_id;
  return request_id;
end;
$$;
comment on function public.server_request_account_deletion(uuid) is '原子切断账户及其项目授权、请求运行中任务取消并登记后台清理';
revoke execute on function public.server_request_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.server_request_account_deletion(uuid) to service_role;

create or replace function private.reject_deleted_owner_job_writeback()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.state in ('succeeded', 'partial') and old.state not in ('succeeded', 'partial') and (
    not exists (select 1 from public.profiles where id = new.owner_id and status = 'active')
    or (new.project_id is not null and not exists (select 1 from public.projects where id = new.project_id and owner_id = new.owner_id and state in ('draft', 'archived')))
  ) then
    raise exception using errcode = '55000', message = 'deleted owner cannot receive job results';
  end if;
  return new;
end;
$$;
comment on function private.reject_deleted_owner_job_writeback() is '阻止删除中的账户或项目接收成功任务结果';
revoke execute on function private.reject_deleted_owner_job_writeback() from public, anon, authenticated, service_role;
drop trigger if exists jobs_reject_deleted_owner_writeback on public.jobs;
create trigger jobs_reject_deleted_owner_writeback before update of state, result_ref on public.jobs for each row execute function private.reject_deleted_owner_job_writeback();
comment on trigger jobs_reject_deleted_owner_writeback on public.jobs is '任务成功写回前重新验证账户与项目仍可用';

alter table public.deletion_requests enable row level security;
revoke all on table public.deletion_requests from anon, authenticated, service_role;
grant select, insert, update, delete on table public.deletion_requests to service_role;
