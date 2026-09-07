do $$
begin
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'export_format') then
    create type public.export_format as enum ('png_zip', 'jpg_zip', 'pdf', 'pptx', 'mp4', 'caption_txt', 'caption_md', 'png', 'jpg', 'account_zip');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'export_state') then
    create type public.export_state as enum ('pending', 'ready', 'failed', 'expired', 'deleted');
  end if;
end
$$;

comment on type public.export_format is '受控的导出成品格式';
comment on type public.export_state is '导出成品生命周期状态';

insert into storage.buckets (id, name, public)
values ('exports', 'exports', false)
on conflict (id) do update set public = false;

create table if not exists public.exports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  project_version_id uuid not null references public.project_versions (id) on delete restrict,
  job_id uuid not null unique references public.jobs (id) on delete restrict,
  format public.export_format not null,
  options jsonb not null default '{}'::jsonb check (jsonb_typeof(options) = 'object'),
  renderer_version text not null check (length(btrim(renderer_version)) > 0),
  manifest jsonb not null default '{}'::jsonb check (jsonb_typeof(manifest) = 'object'),
  asset_id uuid references public.assets (id) on delete restrict,
  state public.export_state not null default 'pending',
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  constraint exports_ready_asset_check check (state <> 'ready' or asset_id is not null)
);

comment on table public.exports is '固定主体版本的单格式导出记录';
comment on column public.exports.id is '导出唯一标识';
comment on column public.exports.owner_id is '导出所有者标识';
comment on column public.exports.project_id is '所属项目标识';
comment on column public.exports.project_version_id is '固定项目快照标识';
comment on column public.exports.job_id is '生成该单格式成品的任务标识';
comment on column public.exports.format is '成品文件格式';
comment on column public.exports.options is '恢复附件、音频或时长等导出选项';
comment on column public.exports.renderer_version is '确定性渲染器版本';
comment on column public.exports.manifest is '尺寸、顺序与文件哈希清单';
comment on column public.exports.asset_id is '可选成品对象素材标识';
comment on column public.exports.state is '成品待处理、可用、失败、到期或删除状态';
comment on column public.exports.expires_at is '成品授权到期时间（UTC）';
comment on column public.exports.created_at is '创建时间（UTC）';

create index if not exists exports_project_created_idx on public.exports (project_id, created_at desc) where project_id is not null;
create index if not exists exports_owner_state_idx on public.exports (owner_id, state, expires_at);
create index if not exists exports_project_version_idx on public.exports (project_version_id) where project_version_id is not null;
create index if not exists exports_asset_idx on public.exports (asset_id) where asset_id is not null;
create unique index if not exists jobs_one_active_generation_per_owner_idx
on public.jobs (owner_id)
where kind = 'generation' and state in ('pending_dispatch', 'queued', 'running');

comment on index public.exports_project_created_idx is '按项目倒序读取导出历史';
comment on index public.exports_owner_state_idx is '按所有者、状态和到期时间授权导出';
comment on index public.exports_project_version_idx is '定位固定项目快照的导出记录';
comment on index public.exports_asset_idx is '定位成品对象关联的导出记录';
comment on index public.jobs_one_active_generation_per_owner_idx is '数据库原子限制每位用户仅有一个活跃生成任务';

alter table public.exports enable row level security;
revoke all on table public.exports from anon, authenticated, service_role;
grant select on table public.exports to authenticated;
grant select, insert, update, delete on table public.exports to service_role;

drop policy if exists exports_select_own_active on public.exports;
create policy exports_select_own_active on public.exports for select to authenticated
using (
  (select auth.uid()) = owner_id
  and state not in ('deleted')
  and exists (select 1 from public.profiles where id = (select auth.uid()) and status = 'active')
  and exists (
    select 1 from public.projects where id = project_id and owner_id = (select auth.uid()) and state in ('draft', 'archived')
  )
);

drop policy if exists storage_download_owned_exports on storage.objects;
create policy storage_download_owned_exports on storage.objects for select to authenticated
using (
  bucket_id = 'exports'
  and exists (
    select 1
    from public.assets
    join public.exports on exports.asset_id = assets.id
    where assets.bucket = 'exports'
      and assets.object_key = storage.objects.name
      and assets.owner_id = (select auth.uid())
      and assets.purpose = 'export'
      and assets.state = 'ready'
      and exports.owner_id = (select auth.uid())
      and exports.state = 'ready'
      and exports.expires_at > now()
      and exists (select 1 from public.profiles where id = (select auth.uid()) and status = 'active')
      and exists (
        select 1 from public.projects
        where projects.id = exports.project_id
          and projects.owner_id = (select auth.uid())
          and projects.state in ('draft', 'archived')
      )
  )
);

create or replace function private.b04_finish_job_with_unknown_cost(
  p_job_id uuid,
  p_succeeded boolean,
  p_result_ref jsonb,
  p_error_code text
)
returns public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.jobs;
  account_id uuid;
  reserved_units bigint;
begin
  select * into target from public.jobs where id = p_job_id for update;
  if target.id is null then raise exception using errcode = '22023', message = 'job not found'; end if;
  if target.state in ('succeeded', 'partial', 'failed', 'canceled') then return target; end if;

  select usage_ledger.account_id, usage_ledger.units into account_id, reserved_units
  from public.usage_ledger
  where job_id = p_job_id and kind = 'reserve'
  order by created_at limit 1;
  if account_id is not null then
    update public.usage_accounts
    set reserved = reserved - reserved_units,
        consumed = consumed + case when p_succeeded and target.cancel_requested_at is null then reserved_units else 0 end,
        updated_at = now()
    where id = account_id and reserved >= reserved_units;
    if not found then raise exception using errcode = '22003', message = 'usage reservation invariant failed'; end if;
    insert into public.usage_ledger (account_id, job_id, event_key, kind, units)
    values (
      account_id, p_job_id, 'job:' || p_job_id::text || ':b04-final',
      case when p_succeeded and target.cancel_requested_at is null then 'settle'::public.usage_ledger_kind else 'release'::public.usage_ledger_kind end,
      reserved_units
    ) on conflict (event_key) do nothing;
  end if;

  update private.cost_reservations
  set state = 'unknown', updated_at = now()
  where job_id = p_job_id and state = 'open';
  update private.cost_attempts
  set state = 'unknown'
  where reservation_id in (select id from private.cost_reservations where job_id = p_job_id)
    and state in ('planned', 'sent');

  update public.jobs
  set state = case when cancel_requested_at is not null then 'canceled'::public.job_state
                   when p_succeeded then 'succeeded'::public.job_state else 'failed'::public.job_state end,
      progress = case when p_succeeded and cancel_requested_at is null then 100 else progress end,
      result_ref = case when p_succeeded and cancel_requested_at is null then p_result_ref else null end,
      error_code = case when p_succeeded and cancel_requested_at is null then null else coalesce(p_error_code, 'CANCELED') end,
      updated_at = now(), finished_at = now(), lease_token = null
  where id = p_job_id
  returning * into target;
  return target;
end;
$$;
comment on function private.b04_finish_job_with_unknown_cost(uuid, boolean, jsonb, text) is '在供应商未返回真实成本时保守保留成本预留并终结用户任务额度';
revoke execute on function private.b04_finish_job_with_unknown_cost(uuid, boolean, jsonb, text) from public, anon, authenticated;
grant execute on function private.b04_finish_job_with_unknown_cost(uuid, boolean, jsonb, text) to service_role;

create or replace function public.server_create_text_source(
  p_owner_id uuid, p_kind public.source_kind, p_metadata jsonb, p_segments jsonb,
  p_expires_at timestamptz, p_idempotency_key text, p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare receipt private.operation_receipts; created public.sources; response jsonb; operation_name text := 'create_text_source';
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
  if p_kind not in ('topic', 'text') or jsonb_typeof(p_metadata) <> 'object' or jsonb_typeof(p_segments) <> 'array'
    or p_expires_at <= now() then raise exception using errcode = '22023', message = 'invalid text source'; end if;
  if not exists (select 1 from public.profiles where id = p_owner_id and status = 'active') then
    raise exception using errcode = '42501', message = 'account is not active';
  end if;
  insert into public.sources (owner_id, kind, metadata, segments, state, expires_at)
  values (p_owner_id, p_kind, p_metadata, p_segments, 'ready', p_expires_at) returning * into created;
  response := jsonb_build_object('sourceId', created.id, 'expiresAt', created.expires_at, 'state', created.state, 'httpStatus', 201);
  insert into private.operation_receipts (owner_id, operation, idempotency_key, request_hash, status, response_ref)
  values (p_owner_id, operation_name, p_idempotency_key, p_request_hash, 'completed', response);
  return response;
end;
$$;
comment on function public.server_create_text_source(uuid, public.source_kind, jsonb, jsonb, timestamptz, text, text) is '服务端原子保存 Topic/Text 来源与无正文幂等回执的受限入口';
revoke execute on function public.server_create_text_source(uuid, public.source_kind, jsonb, jsonb, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.server_create_text_source(uuid, public.source_kind, jsonb, jsonb, timestamptz, text, text) to service_role;

create or replace function public.server_begin_guest_generation(
  p_environment text, p_expires_at timestamptz, p_operation_key text, p_period text,
  p_rate_limit integer, p_request_hash text, p_reserved_micro_usd bigint,
  p_subject_hash text, p_window_start timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare guard private.request_guards; budget private.cost_budgets; created_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_subject_hash || ':guest:' || p_operation_key, 0));
  select * into guard from private.request_guards where subject_hash = p_subject_hash and operation_key = p_operation_key;
  if guard.id is not null then
    if guard.request_hash <> p_request_hash then return jsonb_build_object('outcome', 'idempotency_conflict'); end if;
    if guard.expires_at <= now() then return jsonb_build_object('outcome', 'result_not_retained'); end if;
    if guard.state = 'processing' then return jsonb_build_object('outcome', 'accepted', 'guardId', guard.id); end if;
    return jsonb_build_object('outcome', 'result_not_retained');
  end if;
  if (select count(*) from private.request_guards where subject_hash = p_subject_hash and window_start = p_window_start) >= p_rate_limit then
    return jsonb_build_object('outcome', 'rate_limited');
  end if;
  select * into budget from private.cost_budgets where period = p_period and environment = p_environment for update;
  if budget.period is null or p_reserved_micro_usd < 0
    or budget.limit_micro_usd - budget.reserved_micro_usd - budget.spent_micro_usd < p_reserved_micro_usd then
    return jsonb_build_object('outcome', 'budget_exceeded');
  end if;
  insert into private.request_guards (subject_hash, operation_key, request_hash, state, window_start, expires_at)
  values (p_subject_hash, p_operation_key, p_request_hash, 'processing', p_window_start, p_expires_at)
  returning id into created_id;
  update private.cost_budgets set reserved_micro_usd = reserved_micro_usd + p_reserved_micro_usd, updated_at = now()
  where period = p_period and environment = p_environment;
  insert into private.cost_reservations (guest_guard_id, environment, period, operation_key, reserved_micro_usd)
  values (created_id, p_environment, p_period, 'guest:' || created_id::text, p_reserved_micro_usd);
  return jsonb_build_object('outcome', 'accepted', 'guardId', created_id);
end;
$$;
comment on function public.server_begin_guest_generation(text, timestamptz, text, text, integer, text, bigint, text, timestamptz) is '服务端以不可逆主体摘要原子执行匿名幂等、限速与成本预留';
revoke execute on function public.server_begin_guest_generation(text, timestamptz, text, text, integer, text, bigint, text, timestamptz) from public, anon, authenticated;
grant execute on function public.server_begin_guest_generation(text, timestamptz, text, text, integer, text, bigint, text, timestamptz) to service_role;

create or replace function public.server_finish_guest_generation(p_guard_id uuid, p_outcome text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_outcome not in ('succeeded', 'failed') then raise exception using errcode = '22023', message = 'invalid guest outcome'; end if;
  update private.request_guards set state = p_outcome where id = p_guard_id and state = 'processing';
  update private.cost_reservations set state = 'unknown', updated_at = now()
  where guest_guard_id = p_guard_id and state = 'open';
  return found;
end;
$$;
comment on function public.server_finish_guest_generation(uuid, text) is '服务端终结匿名请求元数据并在缺少真实费用时保守保持成本占用';
revoke execute on function public.server_finish_guest_generation(uuid, text) from public, anon, authenticated;
grant execute on function public.server_finish_guest_generation(uuid, text) to service_role;

create or replace function public.server_claim_generation_job(p_job_id uuid)
returns table (job_id uuid, owner_id uuid, lease_token uuid, source jsonb, options jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare target public.jobs; source_row public.sources; claimed_lease uuid := gen_random_uuid(); reservation_id uuid;
begin
  select * into target from public.jobs where id = p_job_id and kind = 'generation' for update;
  if target.id is null or target.state not in ('pending_dispatch', 'queued') or target.cancel_requested_at is not null then return; end if;
  select * into source_row from public.sources
  where id = (target.input_ref ->> 'sourceId')::uuid and owner_id = target.owner_id
    and state = 'ready' and expires_at > now();
  if source_row.id is null or not exists (select 1 from public.profiles where id = target.owner_id and status = 'active') then return; end if;
  update public.jobs set state = 'running', stage = 'validate', progress = 2, attempt = attempt + 1,
    lease_token = claimed_lease, heartbeat_at = now(), updated_at = now()
  where id = target.id;
  select id into reservation_id from private.cost_reservations where private.cost_reservations.job_id = target.id for update;
  if reservation_id is null then raise exception using errcode = '22023', message = 'cost reservation not found'; end if;
  insert into private.cost_attempts (reservation_id, attempt_key, state)
  values (reservation_id, 'job:' || target.id::text || ':generation:' || (target.attempt + 1)::text, 'sent')
  on conflict (attempt_key) do update set state = case when private.cost_attempts.state = 'planned' then 'sent'::private.cost_attempt_state else private.cost_attempts.state end;
  job_id := target.id;
  owner_id := target.owner_id;
  lease_token := claimed_lease;
  source := jsonb_build_object(
    'id', source_row.id, 'ownerId', source_row.owner_id, 'kind', source_row.kind,
    'metadata', source_row.metadata, 'segments', source_row.segments,
    'state', source_row.state, 'expiresAt', source_row.expires_at
  );
  options := target.input_ref -> 'options';
  return next;
end;
$$;
comment on function public.server_claim_generation_job(uuid) is '服务端以行锁和新 lease 原子认领仍获授权的生成任务并登记供应商尝试';
revoke execute on function public.server_claim_generation_job(uuid) from public, anon, authenticated;
grant execute on function public.server_claim_generation_job(uuid) to service_role;

create or replace function public.server_update_generation_progress(
  p_job_id uuid, p_lease_token uuid, p_stage text, p_progress integer
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_stage not in ('validate', 'outline', 'write', 'layout') or p_progress < 0 or p_progress > 99 then
    raise exception using errcode = '22023', message = 'invalid generation progress';
  end if;
  update public.jobs set stage = p_stage, progress = greatest(progress, p_progress), heartbeat_at = now(), updated_at = now()
  where id = p_job_id and kind = 'generation' and state = 'running'
    and lease_token = p_lease_token and cancel_requested_at is null;
  return found;
end;
$$;
comment on function public.server_update_generation_progress(uuid, uuid, text, integer) is '服务端仅凭当前 lease 单调更新生成任务的真实阶段进度';
revoke execute on function public.server_update_generation_progress(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.server_update_generation_progress(uuid, uuid, text, integer) to service_role;

create or replace function public.server_finalize_generation_job(
  p_job_id uuid, p_lease_token uuid, p_document jsonb, p_error_code text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare target public.jobs;
begin
  select * into target from public.jobs where id = p_job_id and kind = 'generation' for update;
  if target.id is null then return false; end if;
  if target.state in ('succeeded', 'failed', 'canceled') then return target.state = 'succeeded'; end if;
  if target.state <> 'running' or target.lease_token is distinct from p_lease_token then
    raise exception using errcode = '40001', message = 'stale generation worker lease';
  end if;
  if (p_document is null) = (p_error_code is null) then
    raise exception using errcode = '22023', message = 'exactly one generation result is required';
  end if;
  perform private.b04_finish_job_with_unknown_cost(
    p_job_id, p_document is not null,
    case when p_document is null then null else jsonb_build_object('document', p_document) end,
    p_error_code
  );
  return p_document is not null and target.cancel_requested_at is null;
end;
$$;
comment on function public.server_finalize_generation_job(uuid, uuid, jsonb, text) is '服务端按当前 lease 原子提交生成文档或安全错误并保守标记未知成本';
revoke execute on function public.server_finalize_generation_job(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.server_finalize_generation_job(uuid, uuid, jsonb, text) to service_role;

create or replace function private.b04_begin_ai_candidate_job(
  p_owner_id uuid, p_project_id uuid, p_kind public.job_kind, p_input_ref jsonb,
  p_idempotency_key text, p_request_hash text, p_environment text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare existing public.jobs; account public.usage_accounts; budget private.cost_budgets; created public.jobs; period text := to_char(now() at time zone 'UTC', 'YYYY-MM');
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':b04-ai:' || p_kind::text || ':' || p_idempotency_key, 0));
  select * into existing from public.jobs where owner_id = p_owner_id and kind = p_kind and idempotency_key = p_idempotency_key;
  if existing.id is not null then
    if existing.request_hash <> p_request_hash then return jsonb_build_object('outcome', 'idempotency_conflict'); end if;
    if existing.state = 'succeeded' and existing.result_ref is not null then return jsonb_build_object('outcome', 'replay', 'jobId', existing.id, 'result', existing.result_ref); end if;
    if existing.state in ('pending_dispatch', 'queued', 'running') then return jsonb_build_object('outcome', 'accepted', 'jobId', existing.id); end if;
    return jsonb_build_object('outcome', 'idempotency_conflict');
  end if;
  if not exists (select 1 from public.profiles where id = p_owner_id and status = 'active')
    or not exists (select 1 from public.projects where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived')) then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  select * into account from public.usage_accounts
  where owner_id = p_owner_id and resource = 'generation' and now() >= period_start and now() < period_end
  order by period_start desc limit 1 for update;
  if account.id is null or account.granted - account.reserved - account.consumed < 1 then return jsonb_build_object('outcome', 'quota_exceeded'); end if;
  select * into budget from private.cost_budgets where private.cost_budgets.period = period and environment = p_environment for update;
  if budget.period is null or budget.limit_micro_usd - budget.reserved_micro_usd - budget.spent_micro_usd < 25000 then
    return jsonb_build_object('outcome', 'budget_exceeded');
  end if;
  insert into public.jobs (owner_id, project_id, kind, input_ref, idempotency_key, request_hash, state, stage, progress, attempt, lease_token, heartbeat_at)
  values (p_owner_id, p_project_id, p_kind, p_input_ref, p_idempotency_key, p_request_hash, 'running', 'validate', 2, 1, gen_random_uuid(), now())
  returning * into created;
  update public.usage_accounts set reserved = reserved + 1, updated_at = now() where id = account.id;
  insert into public.usage_ledger (account_id, job_id, event_key, kind, units)
  values (account.id, created.id, 'job:' || created.id::text || ':reserve', 'reserve', 1);
  update private.cost_budgets set reserved_micro_usd = reserved_micro_usd + 25000, updated_at = now()
  where private.cost_budgets.period = period and environment = p_environment;
  insert into private.cost_reservations (job_id, environment, period, operation_key, reserved_micro_usd)
  values (created.id, p_environment, period, 'job:' || created.id::text, 25000);
  insert into private.cost_attempts (reservation_id, attempt_key, state)
  select id, 'job:' || created.id::text || ':candidate:1', 'sent' from private.cost_reservations where job_id = created.id;
  return jsonb_build_object('outcome', 'accepted', 'jobId', created.id);
end;
$$;
comment on function private.b04_begin_ai_candidate_job(uuid, uuid, public.job_kind, jsonb, text, text, text) is '为同步 AI 候选原子预留一次额度与保守供应商成本且不携带正文输入';
revoke execute on function private.b04_begin_ai_candidate_job(uuid, uuid, public.job_kind, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function private.b04_begin_ai_candidate_job(uuid, uuid, public.job_kind, jsonb, text, text, text) to service_role;

create or replace function public.server_begin_rewrite_proposal(
  p_owner_id uuid, p_project_id uuid, p_environment text, p_idempotency_key text,
  p_input_ref jsonb, p_request_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; current_revision bigint;
begin
  select revision into current_revision from public.projects
  where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived');
  if current_revision is null then return jsonb_build_object('outcome', 'not_found'); end if;
  if current_revision <> (p_input_ref ->> 'projectRevision')::bigint then return jsonb_build_object('outcome', 'stale'); end if;
  result := private.b04_begin_ai_candidate_job(p_owner_id, p_project_id, 'rewrite', p_input_ref, p_idempotency_key, p_request_hash, p_environment);
  if result ->> 'outcome' = 'accepted' then return jsonb_build_object('outcome', 'accepted', 'proposalJobId', result ->> 'jobId'); end if;
  if result ->> 'outcome' = 'replay' then return jsonb_build_object('outcome', 'replay', 'proposal', result #> '{result,proposal}'); end if;
  if result ->> 'outcome' = 'idempotency_conflict' then return jsonb_build_object('outcome', 'conflict'); end if;
  return result;
end;
$$;
comment on function public.server_begin_rewrite_proposal(uuid, uuid, text, text, jsonb, text) is '服务端校验项目版本并原子建立不修改项目的改写候选任务';
revoke execute on function public.server_begin_rewrite_proposal(uuid, uuid, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.server_begin_rewrite_proposal(uuid, uuid, text, text, jsonb, text) to service_role;

create or replace function public.server_complete_rewrite_proposal(p_proposal_job_id uuid, p_proposal jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target public.jobs;
begin
  select * into target from public.jobs where id = p_proposal_job_id and kind = 'rewrite' for update;
  if target.id is null then raise exception using errcode = '22023', message = 'rewrite proposal job not found'; end if;
  if target.state = 'succeeded' then return target.result_ref; end if;
  if target.state <> 'running' or p_proposal ->> 'proposalJobId' <> target.id::text
    or p_proposal ->> 'projectId' <> target.project_id::text
    or (p_proposal ->> 'projectRevision')::bigint <> (target.input_ref ->> 'projectRevision')::bigint then
    raise exception using errcode = '40001', message = 'stale rewrite proposal completion';
  end if;
  perform private.b04_finish_job_with_unknown_cost(target.id, true, jsonb_build_object('proposal', p_proposal), null);
  return jsonb_build_object('proposal', p_proposal);
end;
$$;
comment on function public.server_complete_rewrite_proposal(uuid, jsonb) is '服务端将身份和基础版本匹配的改写候选保存到任务结果但不修改项目';
revoke execute on function public.server_complete_rewrite_proposal(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.server_complete_rewrite_proposal(uuid, jsonb) to service_role;

create or replace function public.server_apply_rewrite_proposal(
  p_owner_id uuid, p_project_id uuid, p_expected_revision bigint, p_base_slide_revision bigint,
  p_idempotency_key text, p_proposal_job_id uuid, p_request_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare receipt private.operation_receipts; target public.projects; proposal jsonb; slide jsonb; new_slide jsonb; new_slides jsonb;
  field_name text; slide_id text; before_text text; current_text text; body_index integer; operation_name text := 'apply_rewrite:' || p_project_id::text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || operation_name || ':' || p_idempotency_key, 0));
  select * into receipt from private.operation_receipts where owner_id = p_owner_id and operation = operation_name and idempotency_key = p_idempotency_key;
  if receipt.id is not null then
    if receipt.request_hash <> p_request_hash then return jsonb_build_object('outcome', 'idempotency_conflict'); end if;
    if receipt.expires_at <= now() or not exists (select 1 from public.projects where id = (receipt.response_ref ->> 'projectId')::uuid and owner_id = p_owner_id and state in ('draft', 'archived')) then
      return jsonb_build_object('outcome', 'not_found');
    end if;
    return receipt.response_ref || jsonb_build_object('outcome', 'replay');
  end if;
  select result_ref -> 'proposal' into proposal from public.jobs
  where id = p_proposal_job_id and owner_id = p_owner_id and project_id = p_project_id and kind = 'rewrite' and state = 'succeeded';
  if proposal is null then return jsonb_build_object('outcome', 'not_found'); end if;
  select * into target from public.projects where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived') for update;
  if target.id is null then return jsonb_build_object('outcome', 'not_found'); end if;
  if target.revision <> p_expected_revision or (proposal ->> 'projectRevision')::bigint <> p_expected_revision
    or (proposal ->> 'baseSlideRevision')::bigint <> p_base_slide_revision then return jsonb_build_object('outcome', 'stale'); end if;
  slide_id := proposal ->> 'slideId'; field_name := proposal ->> 'field'; before_text := proposal ->> 'before';
  select value into slide from jsonb_array_elements(target.document -> 'slides') where value ->> 'id' = slide_id limit 1;
  if slide is null or (slide ->> 'revision')::bigint <> p_base_slide_revision then return jsonb_build_object('outcome', 'stale'); end if;
  if field_name in ('title', 'eyebrow', 'cta') then current_text := coalesce(slide ->> field_name, '');
  elsif field_name ~ '^body:[0-9]+$' then
    body_index := split_part(field_name, ':', 2)::integer;
    current_text := slide #>> array['bodyBlocks', body_index::text, 'text'];
  else return jsonb_build_object('outcome', 'stale'); end if;
  if current_text is distinct from before_text then return jsonb_build_object('outcome', 'stale'); end if;
  new_slide := jsonb_set(slide, '{revision}', to_jsonb(p_base_slide_revision + 1));
  if field_name in ('title', 'eyebrow', 'cta') then new_slide := jsonb_set(new_slide, array[field_name], to_jsonb(proposal ->> 'after'));
  else new_slide := jsonb_set(new_slide, array['bodyBlocks', body_index::text, 'text'], to_jsonb(proposal ->> 'after')); end if;
  select jsonb_agg(case when value ->> 'id' = slide_id then new_slide else value end order by ordinality)
  into new_slides from jsonb_array_elements(target.document -> 'slides') with ordinality;
  target.document := jsonb_set(target.document, '{slides}', new_slides);
  update public.projects set document = target.document, revision = revision + 1, updated_at = now()
  where id = target.id and revision = p_expected_revision returning * into target;
  if target.id is null then return jsonb_build_object('outcome', 'stale'); end if;
  insert into public.project_versions (project_id, owner_id, revision, document, reason)
  values (target.id, target.owner_id, target.revision, target.document, 'manual');
  insert into private.operation_receipts (owner_id, operation, idempotency_key, request_hash, status, response_ref)
  values (p_owner_id, operation_name, p_idempotency_key, p_request_hash, 'completed',
    jsonb_build_object('projectId', target.id, 'revision', target.revision));
  return jsonb_build_object('outcome', 'applied', 'projectId', target.id, 'revision', target.revision);
end;
$$;
comment on function public.server_apply_rewrite_proposal(uuid, uuid, bigint, bigint, text, uuid, text) is '服务端以项目和页面 revision CAS 原子应用改写候选及写入无正文回执';
revoke execute on function public.server_apply_rewrite_proposal(uuid, uuid, bigint, bigint, text, uuid, text) from public, anon, authenticated;
grant execute on function public.server_apply_rewrite_proposal(uuid, uuid, bigint, bigint, text, uuid, text) to service_role;

create or replace function public.server_begin_regeneration_candidate(
  p_owner_id uuid, p_project_id uuid, p_project_revision bigint, p_options jsonb,
  p_environment text, p_idempotency_key text, p_request_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; current_revision bigint;
begin
  select revision into current_revision from public.projects
  where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived');
  if current_revision is null then return jsonb_build_object('outcome', 'not_found'); end if;
  if current_revision <> p_project_revision then return jsonb_build_object('outcome', 'stale'); end if;
  begin
    result := private.b04_begin_ai_candidate_job(
      p_owner_id, p_project_id, 'generation',
      jsonb_build_object('projectRevision', p_project_revision, 'options', p_options, 'operation', 'regeneration'),
      p_idempotency_key, p_request_hash, p_environment
    );
  exception when unique_violation then
    return jsonb_build_object('outcome', 'quota_exceeded');
  end;
  if result ->> 'outcome' = 'accepted' then return jsonb_build_object('outcome', 'accepted', 'candidateJobId', result ->> 'jobId'); end if;
  if result ->> 'outcome' = 'replay' then return jsonb_build_object('outcome', 'replay', 'candidate', result #> '{result,candidate}'); end if;
  return result;
end;
$$;
comment on function public.server_begin_regeneration_candidate(uuid, uuid, bigint, jsonb, text, text, text) is '服务端校验项目 revision 并原子建立不覆盖现稿的重新生成候选任务';
revoke execute on function public.server_begin_regeneration_candidate(uuid, uuid, bigint, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.server_begin_regeneration_candidate(uuid, uuid, bigint, jsonb, text, text, text) to service_role;

create or replace function public.server_complete_regeneration_candidate(p_candidate_job_id uuid, p_candidate jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target public.jobs;
begin
  select * into target from public.jobs where id = p_candidate_job_id and kind = 'generation' for update;
  if target.id is null then raise exception using errcode = '22023', message = 'regeneration candidate job not found'; end if;
  if target.state = 'succeeded' then return target.result_ref; end if;
  if target.state <> 'running' or target.input_ref ->> 'operation' <> 'regeneration'
    or p_candidate ->> 'candidateJobId' <> target.id::text
    or p_candidate ->> 'projectId' <> target.project_id::text
    or (p_candidate ->> 'projectRevision')::bigint <> (target.input_ref ->> 'projectRevision')::bigint then
    raise exception using errcode = '40001', message = 'stale regeneration candidate completion';
  end if;
  perform private.b04_finish_job_with_unknown_cost(target.id, true, jsonb_build_object('candidate', p_candidate), null);
  return jsonb_build_object('candidate', p_candidate);
end;
$$;
comment on function public.server_complete_regeneration_candidate(uuid, jsonb) is '服务端保存身份和基础版本匹配的重新生成候选但不修改项目';
revoke execute on function public.server_complete_regeneration_candidate(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.server_complete_regeneration_candidate(uuid, jsonb) to service_role;

create or replace function public.server_confirm_regeneration_candidate(
  p_owner_id uuid, p_project_id uuid, p_candidate_job_id uuid, p_expected_revision bigint,
  p_mode text, p_idempotency_key text, p_request_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare receipt private.operation_receipts; target public.projects; candidate jsonb; saved public.projects;
  response jsonb; operation_name text := 'confirm_regeneration:' || p_project_id::text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || operation_name || ':' || p_idempotency_key, 0));
  select * into receipt from private.operation_receipts where owner_id = p_owner_id and operation = operation_name and idempotency_key = p_idempotency_key;
  if receipt.id is not null then
    if receipt.request_hash <> p_request_hash then return jsonb_build_object('outcome', 'idempotency_conflict'); end if;
    if receipt.expires_at <= now() or not exists (
      select 1 from public.projects where id = (receipt.response_ref ->> 'projectId')::uuid and owner_id = p_owner_id and state in ('draft', 'archived')
    ) then return jsonb_build_object('outcome', 'not_found'); end if;
    return receipt.response_ref || jsonb_build_object('outcome', 'replay');
  end if;
  if p_mode not in ('replace', 'save_copy') then raise exception using errcode = '22023', message = 'invalid regeneration confirmation mode'; end if;
  select result_ref -> 'candidate' into candidate from public.jobs
  where id = p_candidate_job_id and owner_id = p_owner_id and project_id = p_project_id
    and kind = 'generation' and state = 'succeeded' and input_ref ->> 'operation' = 'regeneration';
  if candidate is null then return jsonb_build_object('outcome', 'not_found'); end if;
  select * into target from public.projects where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived') for update;
  if target.id is null then return jsonb_build_object('outcome', 'not_found'); end if;
  if target.revision <> p_expected_revision or (candidate ->> 'projectRevision')::bigint <> p_expected_revision then
    return jsonb_build_object('outcome', 'stale');
  end if;
  if p_mode = 'replace' then
    update public.projects
    set title = candidate #>> '{document,title}', platform = (candidate #>> '{document,platform}')::public.platform_preset,
        document = candidate -> 'document', revision = revision + 1, updated_at = now()
    where id = target.id and revision = p_expected_revision returning * into saved;
    if saved.id is null then return jsonb_build_object('outcome', 'stale'); end if;
    insert into public.project_versions (project_id, owner_id, revision, document, reason)
    values (saved.id, saved.owner_id, saved.revision, saved.document, 'pre_generation');
  else
    saved := private.create_project(
      p_owner_id, candidate #>> '{document,title}',
      (candidate #>> '{document,platform}')::public.platform_preset, candidate -> 'document'
    );
  end if;
  response := jsonb_build_object('projectId', saved.id, 'revision', saved.revision);
  insert into private.operation_receipts (owner_id, operation, idempotency_key, request_hash, status, response_ref)
  values (p_owner_id, operation_name, p_idempotency_key, p_request_hash, 'completed', response);
  return response || jsonb_build_object('outcome', 'confirmed');
end;
$$;
comment on function public.server_confirm_regeneration_candidate(uuid, uuid, uuid, bigint, text, text, text) is '服务端经确认以项目 revision CAS 原子替换现稿或另存副本并记录安全回执';
revoke execute on function public.server_confirm_regeneration_candidate(uuid, uuid, uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.server_confirm_regeneration_candidate(uuid, uuid, uuid, bigint, text, text, text) to service_role;

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
    or exists (select 1 from unnest(p_formats) value where value not in ('png_zip', 'jpg_zip', 'pdf'))
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
      jsonb_build_object('projectVersionId', version_id, 'exportId', gen_random_uuid(), 'format', requested, 'rendererVersion', 'b04-v1'),
      p_idempotency_key || ':' || requested, p_request_hash
    ) returning id into job_id;
    insert into public.exports (
      id, owner_id, project_id, project_version_id, job_id, format, options, renderer_version, manifest, state
    ) values (
      (select (input_ref ->> 'exportId')::uuid from public.jobs where id = job_id),
      p_owner_id, p_project_id, version_id, job_id, requested::public.export_format,
      p_options || jsonb_build_object('confirmedWarnings', to_jsonb(p_confirmed_warnings)), 'b04-v1', '{}'::jsonb, 'pending'
    ) returning * into created_export;
    created_ids := created_ids || jsonb_build_array(created_export.id);
    export_id := created_export.id; format := created_export.format::text;
    return next;
  end loop;
  insert into private.operation_receipts (owner_id, operation, idempotency_key, request_hash, status, response_ref)
  values (p_owner_id, operation_name, p_idempotency_key, p_request_hash, 'completed', jsonb_build_object('exportIds', created_ids));
end;
$$;
comment on function public.server_create_exports(uuid, uuid, bigint, text[], jsonb, text[], text, text) is '服务端固定项目快照并为每种基础格式原子创建引用型导出任务与安全回执';
revoke execute on function public.server_create_exports(uuid, uuid, bigint, text[], jsonb, text[], text, text) from public, anon, authenticated;
grant execute on function public.server_create_exports(uuid, uuid, bigint, text[], jsonb, text[], text, text) to service_role;

create or replace function public.server_finalize_export(
  p_job_id uuid, p_export_id uuid, p_asset_id uuid, p_manifest jsonb,
  p_result_ref jsonb, p_finished_at timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare target_job public.jobs; target_export public.exports; target_asset public.assets;
begin
  select * into target_job from public.jobs where id = p_job_id and kind = 'export' for update;
  select * into target_export from public.exports where id = p_export_id for update;
  select * into target_asset from public.assets where id = p_asset_id for update;
  if target_job.id is null or target_export.id is null or target_asset.id is null then return false; end if;
  if target_job.state = 'succeeded' then
    return target_export.state = 'ready' and target_export.asset_id = p_asset_id and target_job.result_ref = p_result_ref;
  end if;
  if target_job.state <> 'running' or target_job.cancel_requested_at is not null
    or target_export.state <> 'pending' or target_export.job_id <> target_job.id
    or target_export.owner_id <> target_job.owner_id or target_export.project_id <> target_job.project_id
    or target_asset.owner_id <> target_job.owner_id or target_asset.bucket <> 'exports'
    or target_asset.purpose <> 'export' or target_asset.kind <> 'derived' or target_asset.state <> 'ready'
    or target_asset.rights ->> 'projectVersionId' <> target_export.project_version_id::text
    or p_result_ref ->> 'exportId' <> target_export.id::text
    or p_result_ref ->> 'assetId' <> target_asset.id::text
    or p_result_ref ->> 'projectVersionId' <> target_export.project_version_id::text
    or p_result_ref ->> 'format' <> target_export.format::text
    or jsonb_typeof(p_manifest) <> 'object' or p_finished_at > now() + interval '5 minutes' then
    raise exception using errcode = '40001', message = 'export finalization binding failed';
  end if;
  update public.exports set manifest = p_manifest, asset_id = p_asset_id, state = 'ready'
  where id = target_export.id;
  update public.jobs set state = 'succeeded', stage = 'upload', progress = 100, result_ref = p_result_ref,
    error_code = null, heartbeat_at = p_finished_at, updated_at = p_finished_at, finished_at = p_finished_at
  where id = target_job.id and state = 'running';
  return found;
end;
$$;
comment on function public.server_finalize_export(uuid, uuid, uuid, jsonb, jsonb, timestamptz) is '服务端原子绑定同所有者任务、导出、固定快照与已验证成品对象并提交终态';
revoke execute on function public.server_finalize_export(uuid, uuid, uuid, jsonb, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.server_finalize_export(uuid, uuid, uuid, jsonb, jsonb, timestamptz) to service_role;

notify pgrst, 'reload schema';
