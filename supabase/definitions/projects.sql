do $$
begin
  if not exists (
    select 1 from pg_type
    where typnamespace = 'public'::regnamespace and typname = 'platform_preset'
  ) then
    create type public.platform_preset as enum ('linkedin', 'instagram', 'tiktok');
  end if;
  if not exists (
    select 1 from pg_type
    where typnamespace = 'public'::regnamespace and typname = 'project_state'
  ) then
    create type public.project_state as enum ('draft', 'archived', 'deleting', 'deleted');
  end if;
  if not exists (
    select 1 from pg_type
    where typnamespace = 'public'::regnamespace and typname = 'project_version_reason'
  ) then
    create type public.project_version_reason as enum ('manual', 'pre_generation', 'export', 'restore');
  end if;
end
$$;

comment on type public.platform_preset is '受控的社交平台画布预设';
comment on type public.project_state is '项目生命周期状态';
comment on type public.project_version_reason is '不可变项目快照的建立原因';

grant usage on schema private to service_role;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 200),
  platform public.platform_preset not null,
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  revision bigint not null default 1 check (revision >= 1),
  brand_kit_id uuid,
  state public.project_state not null default 'draft',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_document_identity_check check (
    document @> '{"schemaVersion": 1}'::jsonb
    and document ->> 'title' = title
    and document ->> 'platform' = platform::text
  ),
  constraint projects_deleted_state_check check (
    (state in ('deleting', 'deleted') and deleted_at is not null)
    or (state in ('draft', 'archived') and deleted_at is null)
  )
);

comment on table public.projects is '私有轮播当前稿';
comment on column public.projects.id is '项目唯一标识';
comment on column public.projects.owner_id is '项目所有者标识';
comment on column public.projects.title is '项目库显示标题，与文档标题事务内同步';
comment on column public.projects.platform is '当前输出平台预设';
comment on column public.projects.document is 'CarouselDocument 当前内容，不含原始文件字节';
comment on column public.projects.revision is '乐观并发控制版本';
comment on column public.projects.brand_kit_id is '当前关联品牌标识，删除品牌后可解除但保留文档快照';
comment on column public.projects.state is '项目生命周期状态';
comment on column public.projects.deleted_at is '逻辑删除时间，设置后立即影响授权';
comment on column public.projects.created_at is '创建时间（UTC）';
comment on column public.projects.updated_at is '最近修改时间（UTC）';

create table if not exists public.project_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  owner_id uuid not null references auth.users (id) on delete restrict,
  revision bigint not null check (revision >= 1),
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  reason public.project_version_reason not null,
  created_at timestamptz not null default now(),
  unique (project_id, revision)
);

comment on table public.project_versions is '不可变项目快照';
comment on column public.project_versions.id is '版本记录唯一标识';
comment on column public.project_versions.project_id is '所属项目标识';
comment on column public.project_versions.owner_id is '项目所有者标识';
comment on column public.project_versions.revision is '所保存的编辑版本';
comment on column public.project_versions.document is '该版本的完整 CarouselDocument 快照';
comment on column public.project_versions.reason is '建立快照的业务原因';
comment on column public.project_versions.created_at is '快照创建时间（UTC）';

create index if not exists projects_owner_state_updated_idx
on public.projects (owner_id, state, updated_at desc);
create index if not exists project_versions_owner_created_idx
on public.project_versions (owner_id, created_at desc);
create index if not exists project_versions_project_id_idx
on public.project_versions (project_id);

create or replace function private.reject_project_version_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '55000', message = 'project versions are immutable';
end;
$$;

comment on function private.reject_project_version_mutation() is '阻止历史项目快照被更新或删除';
revoke execute on function private.reject_project_version_mutation() from public, anon, authenticated, service_role;

drop trigger if exists project_versions_are_immutable on public.project_versions;
create trigger project_versions_are_immutable
before update or delete on public.project_versions
for each row execute function private.reject_project_version_mutation();

create or replace function private.create_project(
  p_owner_id uuid,
  p_title text,
  p_platform public.platform_preset,
  p_document jsonb
)
returns public.projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_project public.projects;
begin
  if not exists (
    select 1 from public.profiles
    where id = p_owner_id and status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'account is not active';
  end if;

  insert into public.projects (owner_id, title, platform, document)
  values (p_owner_id, p_title, p_platform, p_document)
  returning * into created_project;

  insert into public.project_versions (project_id, owner_id, revision, document, reason)
  values (created_project.id, p_owner_id, 1, p_document, 'manual');

  return created_project;
end;
$$;

comment on function private.create_project(uuid, text, public.platform_preset, jsonb) is '为已验证的活跃账户创建项目及首个不可变快照';
revoke execute on function private.create_project(uuid, text, public.platform_preset, jsonb) from public, anon, authenticated;
grant execute on function private.create_project(uuid, text, public.platform_preset, jsonb) to service_role;

create or replace function private.save_project(
  p_owner_id uuid,
  p_project_id uuid,
  p_expected_revision bigint,
  p_title text,
  p_platform public.platform_preset,
  p_document jsonb,
  p_reason public.project_version_reason default 'manual'
)
returns public.projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_project public.projects;
begin
  if not exists (
    select 1 from public.profiles
    where id = p_owner_id and status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'account is not active';
  end if;

  update public.projects
  set title = p_title,
      platform = p_platform,
      document = p_document,
      revision = revision + 1,
      updated_at = now()
  where id = p_project_id
    and owner_id = p_owner_id
    and state in ('draft', 'archived')
    and revision = p_expected_revision
  returning * into saved_project;

  if saved_project.id is null then
    raise exception using errcode = '40001', message = 'project revision conflict';
  end if;

  insert into public.project_versions (project_id, owner_id, revision, document, reason)
  values (
    saved_project.id,
    saved_project.owner_id,
    saved_project.revision,
    saved_project.document,
    p_reason
  );

  return saved_project;
end;
$$;

comment on function private.save_project(uuid, uuid, bigint, text, public.platform_preset, jsonb, public.project_version_reason) is '以 expected revision 比较交换保存项目并建立不可变快照';
revoke execute on function private.save_project(uuid, uuid, bigint, text, public.platform_preset, jsonb, public.project_version_reason) from public, anon, authenticated;
grant execute on function private.save_project(uuid, uuid, bigint, text, public.platform_preset, jsonb, public.project_version_reason) to service_role;

alter table public.projects enable row level security;
alter table public.project_versions enable row level security;

revoke all on table public.projects, public.project_versions from anon, authenticated, service_role;
grant select on table public.projects, public.project_versions to authenticated;
grant select, insert, update, delete on table public.projects, public.project_versions to service_role;

drop policy if exists projects_select_own_active on public.projects;
create policy projects_select_own_active
on public.projects
for select
to authenticated
using (
  (select auth.uid()) = owner_id
  and state in ('draft', 'archived')
  and exists (
    select 1 from public.profiles
    where profiles.id = (select auth.uid()) and profiles.status = 'active'
  )
);

drop policy if exists project_versions_select_own_active on public.project_versions;
create policy project_versions_select_own_active
on public.project_versions
for select
to authenticated
using (
  (select auth.uid()) = owner_id
  and exists (
    select 1 from public.projects
    where projects.id = project_id
      and projects.owner_id = (select auth.uid())
      and projects.state in ('draft', 'archived')
  )
  and exists (
    select 1 from public.profiles
    where profiles.id = (select auth.uid()) and profiles.status = 'active'
  )
);
