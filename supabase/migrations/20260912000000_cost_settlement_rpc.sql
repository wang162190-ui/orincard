-- 成本口径的两条链路此前都断着（见 docs/acceptance/costs.md 的阻断 1 与阻断 2）：
--
--   1. private.register_cost_attempt / private.settle_cost_attempt 只 grant 给 service_role，
--      但没有任何 public.server_* 包装器，PostgREST 的 rpc() 根本调不到 → 实测用量从不落库。
--   2. src/trigger/retention.ts 与 tests/cloud/performance.test.ts 直接用 client.schema("private")
--      读私有表。Data API 只暴露 ["public","graphql_public"]，且 private.cost_* 对 service_role 也
--      revoke all，因此那条调用永远返回 PGRST106 → 对账巡检从未成功执行过一次。
--
-- 两条的根因是同一个：服务端拿不到 private.cost_* 的任何合法通路。这里按仓库既有范式补齐——
-- 窄接口、security definer、只 grant service_role。**不暴露 private schema**，那会削弱安全边界。

-- --- 写入路径：注册与结算供应商调用 ------------------------------------------------------------
-- 内层 private.* 自身已是 security definer，故与 server_request_job_cancellation 一致用纯转调。

create or replace function public.server_register_cost_attempt(
  p_job_id uuid,
  p_attempt_key text
)
returns uuid
language sql
set search_path = ''
as $$
  select private.register_cost_attempt(p_job_id, p_attempt_key);
$$;

comment on function public.server_register_cost_attempt(uuid, text)
is '服务端经 Data API 在发送供应商调用前幂等登记一次尝试的受限入口';
revoke execute on function public.server_register_cost_attempt(uuid, text)
from public, anon, authenticated;
grant execute on function public.server_register_cost_attempt(uuid, text)
to service_role;

create or replace function public.server_settle_cost_attempt(
  p_job_id uuid,
  p_attempt_key text,
  p_provider_operation_id text,
  p_usage jsonb,
  p_actual_micro_usd bigint
)
returns uuid
language sql
set search_path = ''
as $$
  select private.settle_cost_attempt(
    p_job_id, p_attempt_key, p_provider_operation_id, p_usage, p_actual_micro_usd
  );
$$;

comment on function public.server_settle_cost_attempt(uuid, text, text, jsonb, bigint)
is '服务端经 Data API 幂等结算一次供应商调用实测用量的受限入口，允许实际成本高于预估';
revoke execute on function public.server_settle_cost_attempt(uuid, text, text, jsonb, bigint)
from public, anon, authenticated;
grant execute on function public.server_settle_cost_attempt(uuid, text, text, jsonb, bigint)
to service_role;

-- --- 只读路径：对账巡检与成本取样 --------------------------------------------------------------
-- 这些函数直接读 private.cost_* 表，而 service_role 对这些表 revoke all，
-- 因此必须 security definer；返回 jsonb 以免把 private 复合类型暴露到 Data API 的类型面上。

create or replace function public.server_count_unsettled_reservations(p_before timestamptz)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select count(*)
  from private.cost_reservations
  where state in ('open', 'unknown')
    and updated_at < p_before;
$$;

comment on function public.server_count_unsettled_reservations(timestamptz)
is '对账巡检用：统计早于给定时刻仍未结算的成本预留条数';
revoke execute on function public.server_count_unsettled_reservations(timestamptz)
from public, anon, authenticated;
grant execute on function public.server_count_unsettled_reservations(timestamptz)
to service_role;

create or replace function public.server_sample_cost_reservations(p_limit integer)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(sample), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', id,
      'period', period,
      'environment', environment,
      'state', state,
      'reserved_micro_usd', reserved_micro_usd,
      'settled_micro_usd', settled_micro_usd,
      'released_micro_usd', released_micro_usd
    ) as sample
    from private.cost_reservations
    order by created_at desc
    limit greatest(p_limit, 0)
  ) as rows;
$$;

comment on function public.server_sample_cost_reservations(integer)
is 'T094 取样用：按创建时间倒序读取成本预留，只回报金额与状态列';
revoke execute on function public.server_sample_cost_reservations(integer)
from public, anon, authenticated;
grant execute on function public.server_sample_cost_reservations(integer)
to service_role;

create or replace function public.server_read_cost_budget(
  p_period text,
  p_environment text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'period', period,
    'environment', environment,
    'limit_micro_usd', limit_micro_usd,
    'reserved_micro_usd', reserved_micro_usd,
    'spent_micro_usd', spent_micro_usd
  )
  from private.cost_budgets
  where period = p_period and environment = p_environment;
$$;

comment on function public.server_read_cost_budget(text, text)
is 'T094 取样用：读取某环境某月的成本预算行，缺行时返回 null';
revoke execute on function public.server_read_cost_budget(text, text)
from public, anon, authenticated;
grant execute on function public.server_read_cost_budget(text, text)
to service_role;

create or replace function public.server_sample_cost_attempts(p_limit integer)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(sample), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'attempt_key', attempt_key,
      'state', state,
      'usage', usage,
      'actual_micro_usd', actual_micro_usd
    ) as sample
    from private.cost_attempts
    order by started_at desc
    limit greatest(p_limit, 0)
  ) as rows;
$$;

comment on function public.server_sample_cost_attempts(integer)
is 'T094 取样用：按开始时间倒序读取供应商调用尝试，只回报状态、用量与实际成本';
revoke execute on function public.server_sample_cost_attempts(integer)
from public, anon, authenticated;
grant execute on function public.server_sample_cost_attempts(integer)
to service_role;
