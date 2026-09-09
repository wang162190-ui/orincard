-- T065 independent tool outputs.
do $$
begin
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'tool_output_state') then
    create type public.tool_output_state as enum ('ready', 'expired', 'deleted');
  end if;
end
$$;
comment on type public.tool_output_state is '独立工具产物的授权生命周期';

create table if not exists public.tool_outputs (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete restrict,
  job_id uuid not null unique references public.jobs (id) on delete restrict,
  tool text not null check (tool in ('caption', 'linkedin-post', 'post-ideas', 'quote-card', 'infographic', 'portrait', 'carousel-to-video')),
  result jsonb not null check (jsonb_typeof(result) = 'object' and result ->> 'kind' in ('text', 'image', 'video')),
  asset_id uuid references public.assets (id) on delete restrict,
  context_project_id uuid references public.projects (id) on delete restrict,
  context_revision bigint,
  state public.tool_output_state not null default 'ready',
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  constraint tool_outputs_context_check check ((context_project_id is null) = (context_revision is null)),
  constraint tool_outputs_asset_check check (
    (result ->> 'kind' = 'text' and asset_id is null)
    or (result ->> 'kind' in ('image', 'video') and asset_id is not null)
  )
);

comment on table public.tool_outputs is '不依附轮播项目的文本、单图或视频工具产物';
comment on column public.tool_outputs.id is '工具产物唯一标识';
comment on column public.tool_outputs.owner_id is '工具产物所有者标识';
comment on column public.tool_outputs.job_id is '生成该产物的唯一工具任务';
comment on column public.tool_outputs.tool is '七种注册工具之一';
comment on column public.tool_outputs.result is '符合 ToolResult 契约且不含原始输入或密钥的结果';
comment on column public.tool_outputs.asset_id is '图片或 MP4 私有对象的素材记录，文本结果为空';
comment on column public.tool_outputs.context_project_id is '用户明确选择上下文时的项目标识';
comment on column public.tool_outputs.context_revision is '用户明确选择上下文时固定的项目版本';
comment on column public.tool_outputs.state is '可下载、已过期或已删除状态';
comment on column public.tool_outputs.expires_at is '产物下载授权截止时间（UTC）';
comment on column public.tool_outputs.created_at is '产物创建时间（UTC）';

create index if not exists tool_outputs_owner_expiry_idx on public.tool_outputs (owner_id, state, expires_at);
create index if not exists tool_outputs_asset_idx on public.tool_outputs (asset_id) where asset_id is not null;

create or replace function public.server_register_tool_output(
  p_id uuid, p_owner_id uuid, p_job_id uuid, p_tool text, p_result jsonb,
  p_context_project_id uuid, p_context_revision bigint, p_expires_at timestamptz,
  p_asset_id uuid, p_object_key text, p_mime text, p_bytes bigint, p_sha256 text,
  p_width integer, p_height integer, p_duration_ms bigint
)
returns public.tool_outputs language plpgsql security definer set search_path = '' as $$
declare created public.tool_outputs; result_kind text;
begin
  result_kind := p_result ->> 'kind';
  if p_tool not in ('caption', 'linkedin-post', 'post-ideas', 'quote-card', 'infographic', 'portrait', 'carousel-to-video')
    or result_kind is null or result_kind not in ('text', 'image', 'video') or p_expires_at <= now()
    or (p_tool in ('caption', 'linkedin-post', 'post-ideas') and result_kind <> 'text')
    or (p_tool in ('quote-card', 'infographic', 'portrait') and result_kind <> 'image')
    or (p_tool = 'carousel-to-video' and result_kind <> 'video') then
    raise exception using errcode = '22023', message = 'invalid tool output';
  end if;
  if not exists (select 1 from public.profiles where id = p_owner_id and status = 'active')
    or not exists (select 1 from public.jobs where id = p_job_id and owner_id = p_owner_id and kind = 'tool') then
    raise exception using errcode = '42501', message = 'tool job is not accessible';
  end if;
  if (p_context_project_id is null) <> (p_context_revision is null) or (
    p_context_project_id is not null and not exists (
      select 1 from public.projects where id = p_context_project_id and owner_id = p_owner_id
      and revision = p_context_revision and state in ('draft', 'archived')
    )
  ) then raise exception using errcode = '42501', message = 'tool context is not accessible'; end if;
  if result_kind = 'text' then
    if p_asset_id is not null or p_object_key is not null then raise exception using errcode = '22023', message = 'text tool output cannot have an object'; end if;
  else
    if p_asset_id is null or p_object_key is null or p_object_key !~ ('^' || p_owner_id::text || '/' || p_job_id::text || '/' || p_id::text || '/')
      or p_bytes <= 0 or p_sha256 !~ '^[0-9a-f]{64}$'
      or (result_kind = 'image' and (p_mime not in ('image/png', 'image/jpeg') or p_width is null or p_height is null))
      or (result_kind = 'video' and (p_mime <> 'video/mp4' or p_duration_ms is null)) then
      raise exception using errcode = '22023', message = 'invalid tool output object';
    end if;
    insert into public.assets (id, owner_id, kind, purpose, bucket, object_key, mime, bytes, sha256, width, height, duration_ms, rights, state)
    values (p_asset_id, p_owner_id, 'derived', 'tool_output', 'exports', p_object_key, p_mime, p_bytes, p_sha256, p_width, p_height, p_duration_ms, jsonb_build_object('tool', p_tool, 'jobId', p_job_id), 'ready');
  end if;
  insert into public.tool_outputs (id, owner_id, job_id, tool, result, asset_id, context_project_id, context_revision, expires_at)
  values (p_id, p_owner_id, p_job_id, p_tool, p_result, p_asset_id, p_context_project_id, p_context_revision, p_expires_at)
  returning * into created;
  return created;
end;
$$;
comment on function public.server_register_tool_output(uuid, uuid, uuid, text, jsonb, uuid, bigint, timestamptz, uuid, text, text, bigint, text, integer, integer, bigint) is '按 owner、工具任务和显式项目版本原子登记独立工具结果及可选私有对象';
revoke execute on function public.server_register_tool_output(uuid, uuid, uuid, text, jsonb, uuid, bigint, timestamptz, uuid, text, text, bigint, text, integer, integer, bigint) from public, anon, authenticated;
grant execute on function public.server_register_tool_output(uuid, uuid, uuid, text, jsonb, uuid, bigint, timestamptz, uuid, text, text, bigint, text, integer, integer, bigint) to service_role;

alter table public.tool_outputs enable row level security;
revoke all on table public.tool_outputs from anon, authenticated, service_role;
grant select on table public.tool_outputs to authenticated;
grant select, insert, update, delete on table public.tool_outputs to service_role;
drop policy if exists tool_outputs_select_own_available on public.tool_outputs;
create policy tool_outputs_select_own_available on public.tool_outputs for select to authenticated using (
  (select auth.uid()) = owner_id and state = 'ready' and expires_at > now()
  and exists (select 1 from public.profiles where id = (select auth.uid()) and status = 'active')
);

drop policy if exists storage_download_owned_tool_outputs on storage.objects;
create policy storage_download_owned_tool_outputs on storage.objects for select to authenticated using (
  bucket_id = 'exports' and exists (
    select 1 from public.assets join public.tool_outputs on tool_outputs.asset_id = assets.id
    where assets.bucket = 'exports' and assets.object_key = storage.objects.name
      and assets.owner_id = (select auth.uid()) and assets.purpose = 'tool_output' and assets.state = 'ready'
      and tool_outputs.owner_id = (select auth.uid()) and tool_outputs.state = 'ready' and tool_outputs.expires_at > now()
      and exists (select 1 from public.profiles where id = (select auth.uid()) and status = 'active')
  )
);
