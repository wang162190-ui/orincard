do $$
begin
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'job_kind') then
    create type public.job_kind as enum ('generation', 'rewrite', 'parse', 'asset', 'export', 'tool', 'cleanup', 'account_export', 'import');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'job_state') then
    create type public.job_state as enum ('pending_dispatch', 'queued', 'running', 'succeeded', 'partial', 'failed', 'canceled');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'usage_ledger_kind') then
    create type public.usage_ledger_kind as enum ('grant', 'reserve', 'settle', 'release', 'reversal');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'private'::regnamespace and typname = 'cost_reservation_state') then
    create type private.cost_reservation_state as enum ('open', 'unknown', 'settled', 'released');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'private'::regnamespace and typname = 'cost_attempt_state') then
    create type private.cost_attempt_state as enum ('planned', 'sent', 'unknown', 'settled');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'private'::regnamespace and typname = 'operation_receipt_status') then
    create type private.operation_receipt_status as enum ('completed', 'failed');
  end if;
end
$$;

comment on type public.job_kind is '后台任务业务类别';
comment on type public.job_state is '后台任务 outbox 与执行状态';
comment on type public.usage_ledger_kind is '用户额度流水类别';
comment on type private.cost_reservation_state is '供应商成本预留状态';
comment on type private.cost_attempt_state is '供应商单次调用状态';
comment on type private.operation_receipt_status is '非任务写操作回执结果类别';

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete restrict,
  project_id uuid references public.projects (id) on delete restrict,
  parent_job_id uuid references public.jobs (id) on delete restrict,
  kind public.job_kind not null,
  input_ref jsonb not null check (jsonb_typeof(input_ref) = 'object'),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 200),
  request_hash text not null check (length(request_hash) >= 32),
  state public.job_state not null default 'pending_dispatch',
  stage text not null default 'validate' check (stage in ('validate', 'parse', 'transcribe', 'outline', 'write', 'layout', 'render', 'package', 'upload')),
  progress integer not null default 0 check (progress between 0 and 100),
  provider_run_id text,
  attempt integer not null default 0 check (attempt between 0 and 3),
  lease_token uuid,
  heartbeat_at timestamptz,
  result_ref jsonb check (result_ref is null or jsonb_typeof(result_ref) = 'object'),
  error_code text,
  cancel_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (owner_id, kind, idempotency_key),
  constraint jobs_terminal_timestamp_check check ((state in ('succeeded', 'partial', 'failed', 'canceled')) = (finished_at is not null)),
  constraint jobs_terminal_progress_check check (state not in ('succeeded', 'partial') or progress = 100)
);

comment on table public.jobs is '异步任务、状态机与事务 outbox';
comment on column public.jobs.id is '业务任务唯一标识';
comment on column public.jobs.owner_id is '任务所有者标识';
comment on column public.jobs.project_id is '可选所属项目标识';
comment on column public.jobs.parent_job_id is '多格式协调父任务标识';
comment on column public.jobs.kind is '生成、改写、解析、素材、导出、工具或清理任务类别';
comment on column public.jobs.input_ref is '仅含已授权对象 ID、参数及基础版本的任务输入引用';
comment on column public.jobs.idempotency_key is '同类逻辑请求的客户端幂等键';
comment on column public.jobs.request_hash is '任务参数一致性摘要，不含原文';
comment on column public.jobs.state is '事务 outbox 与后台执行状态';
comment on column public.jobs.stage is '当前实际执行阶段';
comment on column public.jobs.progress is '已完成单位折算的阶段进度';
comment on column public.jobs.provider_run_id is '云任务供应商运行标识';
comment on column public.jobs.attempt is '当前后台尝试序号';
comment on column public.jobs.lease_token is '当前尝试写回令牌';
comment on column public.jobs.heartbeat_at is '后台任务最近活动时间（UTC）';
comment on column public.jobs.result_ref is '候选内容或结果资源的安全引用';
comment on column public.jobs.error_code is '可向用户公开的错误类别';
comment on column public.jobs.cancel_requested_at is '取消请求持久化时间（UTC）';
comment on column public.jobs.created_at is '创建时间（UTC）';
comment on column public.jobs.updated_at is '最近修改时间（UTC）';
comment on column public.jobs.finished_at is '终态提交时间（UTC）';

create table if not exists public.usage_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete restrict,
  period_start timestamptz not null,
  period_end timestamptz not null,
  resource text not null check (length(btrim(resource)) > 0),
  granted bigint not null default 0 check (granted >= 0),
  reserved bigint not null default 0 check (reserved >= 0),
  consumed bigint not null default 0 check (consumed >= 0),
  updated_at timestamptz not null default now(),
  unique (owner_id, period_start, resource),
  constraint usage_accounts_period_check check (period_end > period_start),
  constraint usage_accounts_balance_check check (reserved + consumed <= granted)
);

comment on table public.usage_accounts is '用户权益周期内的额度桶';
comment on column public.usage_accounts.id is '额度桶唯一标识';
comment on column public.usage_accounts.owner_id is '额度所有者标识';
comment on column public.usage_accounts.period_start is '权益周期开始时间（UTC）';
comment on column public.usage_accounts.period_end is '权益周期结束时间（UTC）';
comment on column public.usage_accounts.resource is 'generation、image、minute 或 export 等资源类别';
comment on column public.usage_accounts.granted is '周期授予额度单位';
comment on column public.usage_accounts.reserved is '尚未结算的预留额度单位';
comment on column public.usage_accounts.consumed is '已经结算的消耗额度单位';
comment on column public.usage_accounts.updated_at is '最近修改时间（UTC）';

create table if not exists public.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.usage_accounts (id) on delete restrict,
  job_id uuid references public.jobs (id) on delete restrict,
  event_key text not null unique check (length(btrim(event_key)) > 0),
  kind public.usage_ledger_kind not null,
  units bigint not null check (units > 0),
  created_at timestamptz not null default now()
);

comment on table public.usage_ledger is '只追加的用户额度流水';
comment on column public.usage_ledger.id is '流水唯一标识';
comment on column public.usage_ledger.account_id is '关联额度桶标识';
comment on column public.usage_ledger.job_id is '可选关联任务标识';
comment on column public.usage_ledger.event_key is '幂等业务事件唯一键';
comment on column public.usage_ledger.kind is '授予、预留、结算、释放或反冲类别';
comment on column public.usage_ledger.units is '本次流水涉及的正数额度单位';
comment on column public.usage_ledger.created_at is '流水发生时间（UTC）';

create table if not exists private.cost_budgets (
  period text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  environment text not null check (environment in ('development', 'preview', 'production')),
  limit_micro_usd bigint not null check (limit_micro_usd >= 0),
  reserved_micro_usd bigint not null default 0 check (reserved_micro_usd >= 0),
  spent_micro_usd bigint not null default 0 check (spent_micro_usd >= 0),
  updated_at timestamptz not null default now(),
  primary key (period, environment)
);

comment on table private.cost_budgets is '环境 UTC 月度 AI 供应商成本预算';
comment on column private.cost_budgets.period is 'UTC 月份，格式 YYYY-MM';
comment on column private.cost_budgets.environment is '预算归属部署环境';
comment on column private.cost_budgets.limit_micro_usd is '预算上限，单位微美元';
comment on column private.cost_budgets.reserved_micro_usd is '未结算预留，单位微美元';
comment on column private.cost_budgets.spent_micro_usd is '已确认实际成本，单位微美元';
comment on column private.cost_budgets.updated_at is '最近修改时间（UTC）';

create table if not exists private.request_guards (
  id uuid primary key default gen_random_uuid(),
  subject_hash text not null check (length(subject_hash) >= 32),
  operation_key text not null check (length(btrim(operation_key)) > 0),
  request_hash text not null check (length(request_hash) >= 32),
  state text not null,
  window_start timestamptz not null,
  count integer not null default 1 check (count > 0),
  expires_at timestamptz not null,
  unique (subject_hash, operation_key),
  constraint request_guards_expiry_check check (expires_at > window_start)
);

comment on table private.request_guards is '匿名与注册请求的去重和速率窗口安全元数据';
comment on column private.request_guards.id is '保护记录唯一标识';
comment on column private.request_guards.subject_hash is '带环境盐的主体窗口摘要，不存原始 IP';
comment on column private.request_guards.operation_key is '请求操作唯一编号';
comment on column private.request_guards.request_hash is '不含正文的 HMAC 输入摘要';
comment on column private.request_guards.state is '请求处理状态';
comment on column private.request_guards.window_start is '速率计数窗口开始时间（UTC）';
comment on column private.request_guards.count is '窗口内请求次数';
comment on column private.request_guards.expires_at is '保护元数据清理时间（UTC）';

create table if not exists private.cost_reservations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.jobs (id) on delete restrict,
  guest_guard_id uuid,
  environment text not null check (environment in ('development', 'preview', 'production')),
  period text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  operation_key text not null unique,
  reserved_micro_usd bigint not null check (reserved_micro_usd >= 0),
  settled_micro_usd bigint not null default 0 check (settled_micro_usd >= 0),
  released_micro_usd bigint not null default 0 check (released_micro_usd >= 0),
  state private.cost_reservation_state not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cost_reservations_subject_check check ((job_id is not null)::integer + (guest_guard_id is not null)::integer = 1),
  constraint cost_reservations_release_check check (released_micro_usd <= reserved_micro_usd)
);

comment on table private.cost_reservations is '请求级可恢复供应商成本预留';
comment on column private.cost_reservations.id is '成本预留唯一标识';
comment on column private.cost_reservations.job_id is '可选注册任务标识';
comment on column private.cost_reservations.guest_guard_id is '可选匿名保护记录标识，不建立延长保留的外键';
comment on column private.cost_reservations.environment is '预算归属部署环境';
comment on column private.cost_reservations.period is '预算归属 UTC 月份';
comment on column private.cost_reservations.operation_key is '逻辑成本预留幂等键';
comment on column private.cost_reservations.reserved_micro_usd is '预留金额，单位微美元';
comment on column private.cost_reservations.settled_micro_usd is '已结算金额，单位微美元';
comment on column private.cost_reservations.released_micro_usd is '已释放金额，单位微美元';
comment on column private.cost_reservations.state is '开放、未知、已结算或已释放状态';
comment on column private.cost_reservations.created_at is '创建时间（UTC）';
comment on column private.cost_reservations.updated_at is '最近修改时间（UTC）';

create table if not exists private.cost_attempts (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references private.cost_reservations (id) on delete restrict,
  attempt_key text not null unique,
  provider_operation_id text,
  state private.cost_attempt_state not null default 'planned',
  usage jsonb not null default '{}'::jsonb check (jsonb_typeof(usage) = 'object'),
  actual_micro_usd bigint check (actual_micro_usd is null or actual_micro_usd >= 0),
  started_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint cost_attempts_settlement_check check ((state = 'settled') = (settled_at is not null and actual_micro_usd is not null))
);

comment on table private.cost_attempts is '每次供应商调用的最小化成本审计';
comment on column private.cost_attempts.id is '供应商调用尝试唯一标识';
comment on column private.cost_attempts.reservation_id is '关联请求级成本预留标识';
comment on column private.cost_attempts.attempt_key is '任务、阶段和尝试序号组成的幂等键';
comment on column private.cost_attempts.provider_operation_id is '可选供应商对账编号';
comment on column private.cost_attempts.state is '计划、已发送、未知或已结算状态';
comment on column private.cost_attempts.usage is '仅含 token、分钟或秒数等数字用量';
comment on column private.cost_attempts.actual_micro_usd is '确认的实际成本，单位微美元';
comment on column private.cost_attempts.started_at is '供应商调用开始时间（UTC）';
comment on column private.cost_attempts.settled_at is '成本结算时间（UTC）';

create table if not exists private.operation_receipts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete restrict,
  operation text not null,
  idempotency_key text not null,
  request_hash text not null check (length(request_hash) >= 32),
  status private.operation_receipt_status not null,
  response_ref jsonb not null check (jsonb_typeof(response_ref) = 'object'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  unique (owner_id, operation, idempotency_key),
  constraint operation_receipts_expiry_check check (expires_at > created_at)
);

comment on table private.operation_receipts is '非任务写操作的幂等回执';
comment on column private.operation_receipts.id is '回执唯一标识';
comment on column private.operation_receipts.owner_id is '操作所有者标识';
comment on column private.operation_receipts.operation is '端点及资源类型';
comment on column private.operation_receipts.idempotency_key is '客户端操作幂等键';
comment on column private.operation_receipts.request_hash is '不含正文的请求 HMAC 摘要';
comment on column private.operation_receipts.status is '完成或失败的结果类别';
comment on column private.operation_receipts.response_ref is '仅含对象标识、revision、状态及 HTTP 码的安全响应引用';
comment on column private.operation_receipts.created_at is '创建时间（UTC）';
comment on column private.operation_receipts.expires_at is '完整回执保留截止时间（UTC）';

create index if not exists jobs_state_updated_idx on public.jobs (state, updated_at);
create index if not exists jobs_owner_created_idx on public.jobs (owner_id, created_at desc);
create index if not exists jobs_project_id_idx on public.jobs (project_id) where project_id is not null;
create index if not exists jobs_parent_job_id_idx on public.jobs (parent_job_id) where parent_job_id is not null;
create index if not exists usage_accounts_owner_period_idx on public.usage_accounts (owner_id, period_end);
create index if not exists usage_ledger_account_id_idx on public.usage_ledger (account_id);
create index if not exists usage_ledger_job_id_idx on public.usage_ledger (job_id) where job_id is not null;
create index if not exists cost_reservations_job_id_idx on private.cost_reservations (job_id) where job_id is not null;
create index if not exists cost_attempts_reservation_id_idx on private.cost_attempts (reservation_id);
create index if not exists operation_receipts_expiry_idx on private.operation_receipts (expires_at);
create index if not exists request_guards_expiry_idx on private.request_guards (expires_at);

create or replace function private.reject_usage_ledger_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = 'usage ledger is append-only';
end;
$$;
comment on function private.reject_usage_ledger_mutation() is '阻止额度流水被更新或删除';
revoke execute on function private.reject_usage_ledger_mutation() from public, anon, authenticated, service_role;
drop trigger if exists usage_ledger_is_append_only on public.usage_ledger;
create trigger usage_ledger_is_append_only before update or delete on public.usage_ledger
for each row execute function private.reject_usage_ledger_mutation();

create or replace function private.submit_job(
  p_owner_id uuid, p_project_id uuid, p_kind public.job_kind, p_input_ref jsonb,
  p_idempotency_key text, p_request_hash text, p_resource text, p_units bigint,
  p_period_start timestamptz, p_period_end timestamptz,
  p_environment text, p_cost_period text, p_reserved_micro_usd bigint
)
returns public.jobs language plpgsql security definer set search_path = '' as $$
declare
  existing_job public.jobs;
  created_job public.jobs;
  usage_account public.usage_accounts;
  cost_budget private.cost_budgets;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':job:' || p_kind::text || ':' || p_idempotency_key, 0));
  select * into existing_job from public.jobs
  where owner_id = p_owner_id and kind = p_kind and idempotency_key = p_idempotency_key;
  if existing_job.id is not null then
    if existing_job.request_hash <> p_request_hash then
      raise exception using errcode = '23505', message = 'idempotency key request hash conflict';
    end if;
    return existing_job;
  end if;

  if not exists (select 1 from public.profiles where id = p_owner_id and status = 'active') then
    raise exception using errcode = '42501', message = 'account is not active';
  end if;
  if p_project_id is not null and not exists (
    select 1 from public.projects where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived')
  ) then
    raise exception using errcode = '42501', message = 'project is not accessible';
  end if;

  select * into usage_account from public.usage_accounts
  where owner_id = p_owner_id and period_start = p_period_start and resource = p_resource
    and period_end = p_period_end and now() >= period_start and now() < period_end
  for update;
  if usage_account.id is null or p_units <= 0 or usage_account.granted - usage_account.reserved - usage_account.consumed < p_units then
    raise exception using errcode = '22003', message = 'insufficient usage balance';
  end if;

  select * into cost_budget from private.cost_budgets
  where period = p_cost_period and environment = p_environment for update;
  if cost_budget.period is null or p_reserved_micro_usd < 0
    or cost_budget.limit_micro_usd - cost_budget.reserved_micro_usd - cost_budget.spent_micro_usd < p_reserved_micro_usd then
    raise exception using errcode = '22003', message = 'environment cost budget exceeded';
  end if;

  insert into public.jobs (owner_id, project_id, kind, input_ref, idempotency_key, request_hash)
  values (p_owner_id, p_project_id, p_kind, p_input_ref, p_idempotency_key, p_request_hash)
  returning * into created_job;
  update public.usage_accounts set reserved = reserved + p_units, updated_at = now() where id = usage_account.id;
  insert into public.usage_ledger (account_id, job_id, event_key, kind, units)
  values (usage_account.id, created_job.id, 'job:' || created_job.id::text || ':reserve', 'reserve', p_units);
  update private.cost_budgets set reserved_micro_usd = reserved_micro_usd + p_reserved_micro_usd, updated_at = now()
  where period = p_cost_period and environment = p_environment;
  insert into private.cost_reservations (job_id, environment, period, operation_key, reserved_micro_usd)
  values (created_job.id, p_environment, p_cost_period, 'job:' || created_job.id::text, p_reserved_micro_usd);
  return created_job;
end;
$$;
comment on function private.submit_job(uuid, uuid, public.job_kind, jsonb, text, text, text, bigint, timestamptz, timestamptz, text, text, bigint) is '幂等创建 outbox 任务并原子预留用户额度及环境成本';
revoke execute on function private.submit_job(uuid, uuid, public.job_kind, jsonb, text, text, text, bigint, timestamptz, timestamptz, text, text, bigint) from public, anon, authenticated;
grant execute on function private.submit_job(uuid, uuid, public.job_kind, jsonb, text, text, text, bigint, timestamptz, timestamptz, text, text, bigint) to service_role;

create or replace function private.register_cost_attempt(p_job_id uuid, p_attempt_key text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare reservation uuid; attempt_id uuid;
begin
  select id into reservation from private.cost_reservations where job_id = p_job_id and state in ('open', 'unknown');
  if reservation is null then raise exception using errcode = '22023', message = 'open cost reservation not found'; end if;
  insert into private.cost_attempts (reservation_id, attempt_key)
  values (reservation, p_attempt_key)
  on conflict (attempt_key) do nothing
  returning id into attempt_id;
  if attempt_id is null then select id into attempt_id from private.cost_attempts where attempt_key = p_attempt_key; end if;
  return attempt_id;
end;
$$;
comment on function private.register_cost_attempt(uuid, text) is '发送供应商调用前幂等记录尝试';
revoke execute on function private.register_cost_attempt(uuid, text) from public, anon, authenticated;
grant execute on function private.register_cost_attempt(uuid, text) to service_role;

create or replace function private.settle_cost_attempt(
  p_job_id uuid,
  p_attempt_key text,
  p_provider_operation_id text,
  p_usage jsonb,
  p_actual_micro_usd bigint
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare settled_attempt private.cost_attempts;
begin
  if p_actual_micro_usd < 0 or jsonb_typeof(p_usage) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid cost attempt settlement';
  end if;
  select attempt.* into settled_attempt
  from private.cost_attempts as attempt
  join private.cost_reservations as reservation on reservation.id = attempt.reservation_id
  where reservation.job_id = p_job_id and attempt.attempt_key = p_attempt_key
  for update of attempt;
  if settled_attempt.id is null then
    raise exception using errcode = '22023', message = 'cost attempt not found';
  end if;
  if settled_attempt.state = 'settled' then
    if settled_attempt.provider_operation_id is distinct from p_provider_operation_id
      or settled_attempt.usage is distinct from p_usage
      or settled_attempt.actual_micro_usd is distinct from p_actual_micro_usd then
      raise exception using errcode = '23505', message = 'cost attempt settlement conflict';
    end if;
    return settled_attempt.id;
  end if;
  update private.cost_attempts
  set provider_operation_id = p_provider_operation_id,
      usage = p_usage,
      actual_micro_usd = p_actual_micro_usd,
      state = 'settled',
      settled_at = now()
  where id = settled_attempt.id
  returning * into settled_attempt;
  return settled_attempt.id;
end;
$$;
comment on function private.settle_cost_attempt(uuid, text, text, jsonb, bigint) is '幂等结算一次供应商调用的实际用量与成本，允许实际成本高于预估';
revoke execute on function private.settle_cost_attempt(uuid, text, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function private.settle_cost_attempt(uuid, text, text, jsonb, bigint) to service_role;

create or replace function private.request_job_cancellation(p_owner_id uuid, p_job_id uuid)
returns public.jobs language plpgsql security definer set search_path = '' as $$
declare target_job public.jobs;
begin
  select * into target_job from public.jobs where id = p_job_id and owner_id = p_owner_id for update;
  if target_job.id is null then raise exception using errcode = '42501', message = 'job is not accessible'; end if;
  if target_job.state not in ('succeeded', 'partial', 'failed', 'canceled') then
    update public.jobs set cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now()
    where id = p_job_id returning * into target_job;
  end if;
  return target_job;
end;
$$;
comment on function private.request_job_cancellation(uuid, uuid) is '与终态事务竞争并持久化任务取消请求';
revoke execute on function private.request_job_cancellation(uuid, uuid) from public, anon, authenticated;
grant execute on function private.request_job_cancellation(uuid, uuid) to service_role;

create or replace function private.finalize_job(
  p_owner_id uuid, p_job_id uuid, p_lease_token uuid, p_requested_state public.job_state,
  p_result_ref jsonb, p_error_code text, p_delivered_units bigint, p_actual_micro_usd bigint, p_event_key text
)
returns public.jobs language plpgsql security definer set search_path = '' as $$
declare
  target_job public.jobs;
  final_state public.job_state;
  reserved_units bigint;
  usage_account_id uuid;
  reservation private.cost_reservations;
begin
  if p_requested_state not in ('succeeded', 'partial', 'failed', 'canceled') then
    raise exception using errcode = '22023', message = 'final state required';
  end if;
  select * into target_job from public.jobs where id = p_job_id and owner_id = p_owner_id for update;
  if target_job.id is null then raise exception using errcode = '42501', message = 'job is not accessible'; end if;
  if target_job.state in ('succeeded', 'partial', 'failed', 'canceled') then return target_job; end if;
  if target_job.lease_token is distinct from p_lease_token then raise exception using errcode = 'PT409', message = 'stale worker lease'; end if;
  final_state := case when target_job.cancel_requested_at is not null then 'canceled'::public.job_state else p_requested_state end;

  select account_id, units into usage_account_id, reserved_units from public.usage_ledger
  where job_id = p_job_id and kind = 'reserve' order by created_at limit 1;
  if usage_account_id is null then raise exception using errcode = '22023', message = 'usage reservation not found'; end if;
  if (final_state in ('succeeded', 'partial') and p_delivered_units <> reserved_units)
    or (final_state in ('failed', 'canceled') and p_delivered_units <> 0) then
    raise exception using errcode = '22023', message = 'delivered units do not match terminal state';
  end if;
  update public.usage_accounts
  set reserved = reserved - reserved_units,
      consumed = consumed + p_delivered_units,
      updated_at = now()
  where id = usage_account_id and reserved >= reserved_units;
  if not found then raise exception using errcode = '22003', message = 'usage reservation invariant failed'; end if;
  insert into public.usage_ledger (account_id, job_id, event_key, kind, units)
  values (usage_account_id, p_job_id, p_event_key,
    case when p_delivered_units > 0 then 'settle'::public.usage_ledger_kind else 'release'::public.usage_ledger_kind end,
    case when p_delivered_units > 0 then p_delivered_units else reserved_units end);

  select * into reservation from private.cost_reservations where job_id = p_job_id for update;
  if reservation.id is null or reservation.state not in ('open', 'unknown') or p_actual_micro_usd < 0 then
    raise exception using errcode = '22003', message = 'cost reservation invariant failed';
  end if;
  if exists (
    select 1 from private.cost_attempts
    where reservation_id = reservation.id and state in ('sent', 'unknown')
  ) or coalesce((
    select sum(actual_micro_usd) from private.cost_attempts
    where reservation_id = reservation.id and state = 'settled'
  ), 0) <> p_actual_micro_usd then
    raise exception using errcode = '22003', message = 'cost attempt audit is incomplete';
  end if;
  update private.cost_budgets
  set reserved_micro_usd = reserved_micro_usd - reservation.reserved_micro_usd,
      spent_micro_usd = spent_micro_usd + p_actual_micro_usd,
      updated_at = now()
  where period = reservation.period and environment = reservation.environment
    and reserved_micro_usd >= reservation.reserved_micro_usd;
  if not found then raise exception using errcode = '22003', message = 'cost budget invariant failed'; end if;
  update private.cost_reservations
  set settled_micro_usd = p_actual_micro_usd,
      released_micro_usd = greatest(reservation.reserved_micro_usd - p_actual_micro_usd, 0),
      state = case when p_actual_micro_usd > 0 then 'settled'::private.cost_reservation_state else 'released'::private.cost_reservation_state end,
      updated_at = now()
  where id = reservation.id;

  update public.jobs
  set state = final_state,
      progress = case when final_state in ('succeeded', 'partial') then 100 else progress end,
      result_ref = case when final_state in ('succeeded', 'partial') then p_result_ref else null end,
      error_code = case when final_state in ('failed', 'canceled') then p_error_code else null end,
      updated_at = now(), finished_at = now()
  where id = p_job_id returning * into target_job;
  return target_job;
end;
$$;
comment on function private.finalize_job(uuid, uuid, uuid, public.job_state, jsonb, text, bigint, bigint, text) is '按当前 lease 一次性提交任务终态并结算或释放额度和成本';
revoke execute on function private.finalize_job(uuid, uuid, uuid, public.job_state, jsonb, text, bigint, bigint, text) from public, anon, authenticated;
grant execute on function private.finalize_job(uuid, uuid, uuid, public.job_state, jsonb, text, bigint, bigint, text) to service_role;

drop function if exists private.save_project(uuid, uuid, bigint, text, public.platform_preset, jsonb, public.project_version_reason);
create or replace function private.save_project(
  p_owner_id uuid, p_project_id uuid, p_expected_revision bigint, p_title text,
  p_platform public.platform_preset, p_document jsonb, p_reason public.project_version_reason,
  p_idempotency_key text, p_request_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved_project public.projects; receipt private.operation_receipts; response jsonb; operation_name text;
begin
  operation_name := 'save_project:' || p_project_id::text;
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || operation_name || ':' || p_idempotency_key, 0));
  select * into receipt from private.operation_receipts
  where owner_id = p_owner_id and operation = operation_name and idempotency_key = p_idempotency_key;
  if receipt.id is not null then
    if receipt.request_hash <> p_request_hash then raise exception using errcode = '23505', message = 'idempotency key request hash conflict'; end if;
    if receipt.expires_at <= now() then raise exception using errcode = '55000', message = 'operation receipt expired'; end if;
    if not exists (select 1 from public.projects where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived')) then
      raise exception using errcode = '42501', message = 'project is not accessible';
    end if;
    return receipt.response_ref;
  end if;
  if not exists (select 1 from public.profiles where id = p_owner_id and status = 'active') then
    raise exception using errcode = '42501', message = 'account is not active';
  end if;
  update public.projects set title = p_title, platform = p_platform, document = p_document,
    revision = revision + 1, updated_at = now()
  where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived')
    and revision = p_expected_revision
  returning * into saved_project;
  if saved_project.id is null then raise exception using errcode = 'PT409', message = 'project revision conflict'; end if;
  insert into public.project_versions (project_id, owner_id, revision, document, reason)
  values (saved_project.id, saved_project.owner_id, saved_project.revision, saved_project.document, p_reason);
  response := jsonb_build_object('projectId', saved_project.id, 'revision', saved_project.revision, 'state', saved_project.state, 'httpStatus', 200);
  insert into private.operation_receipts (owner_id, operation, idempotency_key, request_hash, status, response_ref)
  values (p_owner_id, operation_name, p_idempotency_key, p_request_hash, 'completed', response);
  return response;
end;
$$;
comment on function private.save_project(uuid, uuid, bigint, text, public.platform_preset, jsonb, public.project_version_reason, text, text) is '先重放操作回执，再以 CAS 保存项目、快照和同事务回执';
revoke execute on function private.save_project(uuid, uuid, bigint, text, public.platform_preset, jsonb, public.project_version_reason, text, text) from public, anon, authenticated;
grant execute on function private.save_project(uuid, uuid, bigint, text, public.platform_preset, jsonb, public.project_version_reason, text, text) to service_role;

create or replace function private.save_project(
  p_owner_id uuid, p_project_id uuid, p_expected_revision bigint, p_title text,
  p_platform public.platform_preset, p_document jsonb, p_reason public.project_version_reason default 'manual'
)
returns public.projects language plpgsql security definer set search_path = '' as $$
declare saved public.projects;
begin
  perform private.save_project(
    p_owner_id, p_project_id, p_expected_revision, p_title, p_platform, p_document, p_reason,
    'legacy:' || p_expected_revision::text || ':' || md5(p_document::text),
    md5(p_title || ':' || p_platform::text || ':' || p_document::text)
  );
  select * into saved from public.projects where id = p_project_id and owner_id = p_owner_id;
  return saved;
end;
$$;
comment on function private.save_project(uuid, uuid, bigint, text, public.platform_preset, jsonb, public.project_version_reason) is '兼容早期调用并以确定性回执键转入幂等保存事务';
revoke execute on function private.save_project(uuid, uuid, bigint, text, public.platform_preset, jsonb, public.project_version_reason) from public, anon, authenticated;
grant execute on function private.save_project(uuid, uuid, bigint, text, public.platform_preset, jsonb, public.project_version_reason) to service_role;

alter table public.jobs enable row level security;
alter table public.usage_accounts enable row level security;
alter table public.usage_ledger enable row level security;
alter table private.cost_budgets enable row level security;
alter table private.cost_reservations enable row level security;
alter table private.cost_attempts enable row level security;
alter table private.operation_receipts enable row level security;
alter table private.request_guards enable row level security;

revoke all on table public.jobs, public.usage_accounts, public.usage_ledger from anon, authenticated, service_role;
grant select on table public.jobs, public.usage_accounts, public.usage_ledger to authenticated;
grant select, insert, update, delete on table public.jobs, public.usage_accounts, public.usage_ledger to service_role;
revoke all on table private.cost_budgets, private.cost_reservations, private.cost_attempts, private.operation_receipts, private.request_guards from public, anon, authenticated, service_role;

drop policy if exists jobs_select_own_active on public.jobs;
create policy jobs_select_own_active on public.jobs for select to authenticated
using ((select auth.uid()) = owner_id and exists (select 1 from public.profiles where id = (select auth.uid()) and status = 'active'));
drop policy if exists usage_accounts_select_own_active on public.usage_accounts;
create policy usage_accounts_select_own_active on public.usage_accounts for select to authenticated
using ((select auth.uid()) = owner_id and exists (select 1 from public.profiles where id = (select auth.uid()) and status = 'active'));
drop policy if exists usage_ledger_select_own_active on public.usage_ledger;
create policy usage_ledger_select_own_active on public.usage_ledger for select to authenticated
using (exists (select 1 from public.usage_accounts where id = account_id and owner_id = (select auth.uid())));
