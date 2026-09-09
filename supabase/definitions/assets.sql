do $$
begin
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'brand_kit_state') then
    create type public.brand_kit_state as enum ('active', 'deleting', 'deleted');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'asset_kind') then
    create type public.asset_kind as enum ('upload', 'stock', 'screenshot', 'ai_image', 'portrait', 'audio', 'derived');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'asset_purpose') then
    create type public.asset_purpose as enum ('source', 'media', 'export', 'tool_output', 'account_export');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'asset_state') then
    create type public.asset_state as enum ('pending_upload', 'validating', 'ready', 'failed', 'deleting', 'deleted');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'source_kind') then
    create type public.source_kind as enum ('topic', 'text', 'url', 'pdf', 'slides', 'video');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'source_state') then
    create type public.source_state as enum ('uploading', 'parsing', 'ready', 'failed', 'deleted');
  end if;
end
$$;

comment on type public.brand_kit_state is '品牌配置生命周期状态';
comment on type public.asset_kind is '素材来源或派生类别';
comment on type public.asset_purpose is '对象用途与授权策略类别';
comment on type public.asset_state is '素材验证与删除状态';
comment on type public.source_kind is '注册用户来源输入类别';
comment on type public.source_state is '来源上传、解析和清理状态';

insert into storage.buckets (id, name, public)
values ('sources', 'sources', false), ('assets', 'assets', false)
on conflict (id) do update set public = false;

create table if not exists public.brand_kits (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 100),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  revision bigint not null default 1 check (revision >= 1),
  state public.brand_kit_state not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.brand_kits is '可复用品牌配置';
comment on column public.brand_kits.id is '品牌唯一标识';
comment on column public.brand_kits.owner_id is '品牌所有者标识';
comment on column public.brand_kits.name is '品牌名称';
comment on column public.brand_kits.settings is '显示名称、网站、CTA、颜色、字体、页码配置及资源引用';
comment on column public.brand_kits.revision is '品牌配置乐观并发版本';
comment on column public.brand_kits.state is '品牌生命周期状态';
comment on column public.brand_kits.created_at is '创建时间（UTC）';
comment on column public.brand_kits.updated_at is '最近修改时间（UTC）';

create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete restrict,
  kind public.asset_kind not null,
  purpose public.asset_purpose not null,
  bucket text not null check (bucket in ('sources', 'assets', 'exports')),
  object_key text not null check (length(object_key) > 0 and object_key !~ '(^/|(^|/)\.\.(/|$))'),
  mime text not null check (length(btrim(mime)) > 0),
  bytes bigint not null check (bytes >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  duration_ms bigint check (duration_ms is null or duration_ms >= 0),
  parent_asset_id uuid references public.assets (id) on delete restrict,
  rights jsonb not null default '{}'::jsonb check (jsonb_typeof(rights) = 'object'),
  accepted_at timestamptz,
  library_retained boolean not null default false,
  state public.asset_state not null default 'pending_upload',
  error_code text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bucket, object_key),
  constraint assets_ready_metadata_check check (
    state <> 'ready' or (bytes > 0 and sha256 <> repeat('0', 64))
  )
);

comment on table public.assets is '用户素材、来源文件及处理后派生文件元数据';
comment on column public.assets.id is '素材唯一标识';
comment on column public.assets.owner_id is '素材所有者标识';
comment on column public.assets.kind is '上传、图库、截图、AI、音频或派生类别';
comment on column public.assets.purpose is '来源、媒体、导出、工具产物或账号导出用途';
comment on column public.assets.bucket is '私有 Storage 桶标识';
comment on column public.assets.object_key is '不可猜测且不可覆盖的对象键';
comment on column public.assets.mime is '服务端检测的媒体类型';
comment on column public.assets.bytes is '服务端检测的实际字节数';
comment on column public.assets.sha256 is '对象内容 SHA-256 校验值';
comment on column public.assets.width is '图片像素宽度';
comment on column public.assets.height is '图片像素高度';
comment on column public.assets.duration_ms is '媒体时长（毫秒）';
comment on column public.assets.parent_asset_id is '派生素材的源素材标识';
comment on column public.assets.rights is '来源、作者、许可、用户确认及供应商版本';
comment on column public.assets.accepted_at is '用户接受 AI 候选素材的时间（UTC）';
comment on column public.assets.library_retained is '用户是否明确将素材保留在个人素材库';
comment on column public.assets.state is '素材上传、验证、可用、失败或删除状态';
comment on column public.assets.error_code is '可向用户公开的安全错误类别';
comment on column public.assets.deleted_at is '物理对象删除完成时间（UTC）';
comment on column public.assets.created_at is '创建时间（UTC）';
comment on column public.assets.updated_at is '最近修改时间（UTC）';

create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete restrict,
  project_id uuid references public.projects (id) on delete restrict,
  kind public.source_kind not null,
  asset_id uuid references public.assets (id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  segments jsonb not null default '[]'::jsonb check (jsonb_typeof(segments) in ('array', 'object')),
  state public.source_state not null default 'uploading',
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sources_file_kind_check check (
    (kind in ('pdf', 'slides', 'video') and asset_id is not null)
    or (kind in ('topic', 'text', 'url'))
  )
);

comment on table public.sources is '已注册用户的输入资产及解析定位';
comment on column public.sources.id is '来源唯一标识';
comment on column public.sources.owner_id is '来源所有者标识';
comment on column public.sources.project_id is '可选所属项目标识';
comment on column public.sources.kind is 'Topic、Text、URL、PDF、Slides 或 Video 输入类别';
comment on column public.sources.asset_id is '来源原始文件的素材标识';
comment on column public.sources.metadata is '来源标题、公开 URL、页数或时长等安全元数据';
comment on column public.sources.segments is '带稳定 segmentId 和页码或时间定位的解析段落';
comment on column public.sources.state is '来源上传、解析、可用、失败或删除状态';
comment on column public.sources.expires_at is '原始正文及文件清理时间（UTC）';
comment on column public.sources.created_at is '创建时间（UTC）';
comment on column public.sources.updated_at is '最近修改时间（UTC）';

create table if not exists public.project_asset_refs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  version_id uuid references public.project_versions (id) on delete restrict,
  asset_id uuid not null references public.assets (id) on delete restrict,
  slot_key text not null check (length(btrim(slot_key)) > 0),
  created_at timestamptz not null default now()
);

comment on table public.project_asset_refs is '当前项目及历史版本的素材引用保护';
comment on column public.project_asset_refs.id is '引用唯一标识';
comment on column public.project_asset_refs.project_id is '所属项目标识';
comment on column public.project_asset_refs.version_id is '历史快照标识，为空表示当前稿';
comment on column public.project_asset_refs.asset_id is '被引用的素材标识';
comment on column public.project_asset_refs.slot_key is '文档内引用槽位';
comment on column public.project_asset_refs.created_at is '建立时间（UTC）';

create unique index if not exists project_asset_refs_current_unique
on public.project_asset_refs (project_id, asset_id, slot_key) where version_id is null;
create unique index if not exists project_asset_refs_version_unique
on public.project_asset_refs (version_id, asset_id, slot_key) where version_id is not null;

create table if not exists public.brand_asset_refs (
  brand_kit_id uuid not null references public.brand_kits (id) on delete restrict,
  asset_id uuid not null references public.assets (id) on delete restrict,
  slot_key text not null check (length(btrim(slot_key)) > 0),
  created_at timestamptz not null default now(),
  primary key (brand_kit_id, asset_id, slot_key)
);

comment on table public.brand_asset_refs is '品牌配置的素材引用保护';
comment on column public.brand_asset_refs.brand_kit_id is '品牌配置标识';
comment on column public.brand_asset_refs.asset_id is '被引用的素材标识';
comment on column public.brand_asset_refs.slot_key is 'logo、headshot 等品牌用途';
comment on column public.brand_asset_refs.created_at is '建立时间（UTC）';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.projects'::regclass and conname = 'projects_brand_kit_id_fkey'
  ) then
    alter table public.projects
    add constraint projects_brand_kit_id_fkey
    foreign key (brand_kit_id) references public.brand_kits (id) on delete restrict;
  end if;
end
$$;

create index if not exists brand_kits_owner_state_idx on public.brand_kits (owner_id, state);
create index if not exists assets_owner_state_idx on public.assets (owner_id, state);
create index if not exists assets_parent_asset_id_idx on public.assets (parent_asset_id) where parent_asset_id is not null;
create index if not exists sources_owner_state_idx on public.sources (owner_id, state);
create index if not exists sources_expires_at_idx on public.sources (expires_at) where state <> 'deleted';
create index if not exists sources_project_id_idx on public.sources (project_id) where project_id is not null;
create index if not exists sources_asset_id_idx on public.sources (asset_id) where asset_id is not null;
create index if not exists project_asset_refs_project_id_idx on public.project_asset_refs (project_id);
create index if not exists project_asset_refs_asset_id_idx on public.project_asset_refs (asset_id);
create index if not exists brand_asset_refs_asset_id_idx on public.brand_asset_refs (asset_id);
create index if not exists projects_brand_kit_id_idx on public.projects (brand_kit_id) where brand_kit_id is not null;

create or replace function private.sync_project_brand_kit_id()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  requested_brand_id text;
begin
  requested_brand_id := nullif(new.document #>> '{brandSnapshot,kitId}', '');
  new.brand_kit_id := null;
  if requested_brand_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    select id into new.brand_kit_id from public.brand_kits
    where id = requested_brand_id::uuid and owner_id = new.owner_id and state = 'active';
  end if;
  return new;
end;
$$;

comment on function private.sync_project_brand_kit_id() is '从 CarouselDocument 品牌快照同步项目品牌引用，供影响检查和引用约束使用';

drop trigger if exists projects_sync_brand_kit_id on public.projects;
create trigger projects_sync_brand_kit_id
before insert or update of document on public.projects
for each row execute function private.sync_project_brand_kit_id();

comment on trigger projects_sync_brand_kit_id on public.projects is '项目文档写入时同步 brand_kit_id';

create or replace function private.enforce_owned_resource_links()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  referenced_owner uuid;
  second_owner uuid;
begin
  if tg_table_name = 'assets' then
    if new.parent_asset_id is not null then
      select owner_id into referenced_owner from public.assets where id = new.parent_asset_id;
      if referenced_owner is distinct from new.owner_id then
        raise exception using errcode = '23514', message = 'asset parent must have the same owner';
      end if;
    end if;
  elsif tg_table_name = 'sources' then
    if new.project_id is not null then
      select owner_id into referenced_owner from public.projects where id = new.project_id;
      if referenced_owner is distinct from new.owner_id then
        raise exception using errcode = '23514', message = 'source project must have the same owner';
      end if;
    end if;
    if new.asset_id is not null then
      select owner_id into referenced_owner from public.assets where id = new.asset_id;
      if referenced_owner is distinct from new.owner_id then
        raise exception using errcode = '23514', message = 'source asset must have the same owner';
      end if;
    end if;
  elsif tg_table_name = 'project_asset_refs' then
    select owner_id into referenced_owner from public.projects where id = new.project_id;
    select owner_id into second_owner from public.assets where id = new.asset_id;
    if referenced_owner is distinct from second_owner then
      raise exception using errcode = '23514', message = 'project and asset must have the same owner';
    end if;
    if new.version_id is not null and not exists (
      select 1 from public.project_versions
      where id = new.version_id and project_id = new.project_id and owner_id = referenced_owner
    ) then
      raise exception using errcode = '23514', message = 'version must belong to the referenced project';
    end if;
  elsif tg_table_name = 'brand_asset_refs' then
    select owner_id into referenced_owner from public.brand_kits where id = new.brand_kit_id;
    select owner_id into second_owner from public.assets where id = new.asset_id;
    if referenced_owner is distinct from second_owner then
      raise exception using errcode = '23514', message = 'brand and asset must have the same owner';
    end if;
  elsif tg_table_name = 'projects' and new.brand_kit_id is not null then
    select owner_id into referenced_owner from public.brand_kits where id = new.brand_kit_id;
    if referenced_owner is distinct from new.owner_id then
      raise exception using errcode = '23514', message = 'project and brand must have the same owner';
    end if;
  end if;
  return new;
end;
$$;

comment on function private.enforce_owned_resource_links() is '拒绝项目、品牌、来源和素材之间的跨账户引用';
revoke execute on function private.enforce_owned_resource_links() from public, anon, authenticated, service_role;

drop trigger if exists assets_enforce_owned_parent on public.assets;
create trigger assets_enforce_owned_parent before insert or update of owner_id, parent_asset_id on public.assets
for each row execute function private.enforce_owned_resource_links();
drop trigger if exists sources_enforce_owned_links on public.sources;
create trigger sources_enforce_owned_links before insert or update of owner_id, project_id, asset_id on public.sources
for each row execute function private.enforce_owned_resource_links();
drop trigger if exists project_asset_refs_enforce_owner on public.project_asset_refs;
create trigger project_asset_refs_enforce_owner before insert or update on public.project_asset_refs
for each row execute function private.enforce_owned_resource_links();
drop trigger if exists brand_asset_refs_enforce_owner on public.brand_asset_refs;
create trigger brand_asset_refs_enforce_owner before insert or update on public.brand_asset_refs
for each row execute function private.enforce_owned_resource_links();
drop trigger if exists projects_enforce_brand_owner on public.projects;
create trigger projects_enforce_brand_owner before insert or update of owner_id, brand_kit_id on public.projects
for each row execute function private.enforce_owned_resource_links();

alter table public.brand_kits enable row level security;
alter table public.assets enable row level security;
alter table public.sources enable row level security;
alter table public.project_asset_refs enable row level security;
alter table public.brand_asset_refs enable row level security;

revoke all on table public.brand_kits, public.assets, public.sources, public.project_asset_refs, public.brand_asset_refs from anon, authenticated, service_role;
grant select on table public.brand_kits, public.assets, public.sources, public.project_asset_refs, public.brand_asset_refs to authenticated;
grant select, insert, update, delete on table public.brand_kits, public.assets, public.sources, public.project_asset_refs, public.brand_asset_refs to service_role;

drop policy if exists brand_kits_select_own_active on public.brand_kits;
create policy brand_kits_select_own_active on public.brand_kits for select to authenticated
using ((select auth.uid()) = owner_id and state = 'active' and exists (select 1 from public.profiles where id = (select auth.uid()) and status = 'active'));
drop policy if exists assets_select_own_available on public.assets;
create policy assets_select_own_available on public.assets for select to authenticated
using ((select auth.uid()) = owner_id and state not in ('deleting', 'deleted') and exists (select 1 from public.profiles where id = (select auth.uid()) and status = 'active'));
drop policy if exists sources_select_own_unexpired on public.sources;
create policy sources_select_own_unexpired on public.sources for select to authenticated
using ((select auth.uid()) = owner_id and state <> 'deleted' and expires_at > now() and exists (select 1 from public.profiles where id = (select auth.uid()) and status = 'active'));
drop policy if exists project_asset_refs_select_own_active on public.project_asset_refs;
create policy project_asset_refs_select_own_active on public.project_asset_refs for select to authenticated
using (exists (select 1 from public.projects where id = project_id and owner_id = (select auth.uid()) and state in ('draft', 'archived')));
drop policy if exists brand_asset_refs_select_own_active on public.brand_asset_refs;
create policy brand_asset_refs_select_own_active on public.brand_asset_refs for select to authenticated
using (exists (select 1 from public.brand_kits where id = brand_kit_id and owner_id = (select auth.uid()) and state = 'active'));

drop policy if exists storage_download_owned_or_referenced_assets on storage.objects;
create policy storage_download_owned_or_referenced_assets
on storage.objects for select to authenticated
using (
  bucket_id in ('sources', 'assets')
  and exists (
    select 1
    from public.assets
    where assets.bucket = storage.objects.bucket_id
      and assets.object_key = storage.objects.name
      and assets.owner_id = (select auth.uid())
      and assets.state not in ('deleting', 'deleted')
      and exists (select 1 from public.profiles where id = (select auth.uid()) and status = 'active')
      and (
        (assets.purpose = 'source' and (
          exists (select 1 from public.sources where asset_id = assets.id and state <> 'deleted' and expires_at > now())
          or (assets.created_at > now() - interval '24 hours' and assets.state in ('pending_upload', 'validating', 'ready'))
        ))
        or (assets.purpose = 'media' and assets.state = 'ready'
          and (assets.kind not in ('ai_image', 'portrait') or assets.accepted_at is not null)
          and (
          assets.library_retained
          or exists (select 1 from public.project_asset_refs where asset_id = assets.id)
          or exists (select 1 from public.brand_asset_refs where asset_id = assets.id)
        ))
      )
  )
);
