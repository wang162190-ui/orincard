-- S1 补齐的 server_settle_cost_attempt 只覆盖「应用层已经知道 attempt_key、且预留挂在 job 上」
-- 的调用点。接线五个 DeepSeek 调用点时发现另外两类不适用，这里补上：
--
--   1. 生成任务（src/trigger/generate.ts）：attempt_key 的序号是 public.jobs.attempt，
--      而 server_claim_generation_job 的返回里没有这一列，应用层拼不出 key。与其扩返回值、
--      再把 key 约定复制到 TypeScript 里（拼错一个字符就会另开一行、把同一次调用计两遍），
--      不如让 SQL 自己解析——约定只存在于数据库这一处。
--   2. 访客生成（src/app/api/v1/guest/generate/route.ts）：预留挂在 guest_guard_id 上，
--      job_id 为 null（见 cost_reservations_subject_check），而 private.settle_cost_attempt
--      是按 reservation.job_id 关联的，对访客永远查不到行。
--
-- 不新建表、不放宽任何 grant，全部 revoke from public, anon, authenticated 后只 grant service_role。

-- --- 1. 生成任务：由 SQL 解析 attempt_key ------------------------------------------------------

create or replace function public.server_settle_generation_usage(
  p_job_id uuid,
  p_lease_token uuid,
  p_provider_operation_id text,
  p_usage jsonb,
  p_actual_micro_usd bigint
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare target public.jobs;
begin
  select * into target from public.jobs where id = p_job_id;
  -- 用 lease 校验而不是 owner：结算发生在 worker 里，worker 手上只有 lease。
  -- lease 对不上说明这次运行已经被抢占，它的用量不该记到当前 attempt 上。
  if target.id is null or target.lease_token is distinct from p_lease_token then
    raise exception using errcode = '22023', message = 'generation lease is not valid for settlement';
  end if;
  -- b04 在 claim 里先 attempt = attempt + 1，再以 (claim 前的 attempt + 1) 拼 key，
  -- 因此 claim 之后 public.jobs.attempt 恰好等于 key 里的序号。
  return private.settle_cost_attempt(
    p_job_id,
    'job:' || target.id::text || ':generation:' || target.attempt::text,
    p_provider_operation_id,
    p_usage,
    p_actual_micro_usd
  );
end;
$$;

comment on function public.server_settle_generation_usage(uuid, uuid, text, jsonb, bigint)
is '生成 worker 凭 lease 结算本次 attempt 的实测用量，attempt_key 由数据库自行解析';
revoke execute on function public.server_settle_generation_usage(uuid, uuid, text, jsonb, bigint)
from public, anon, authenticated;
grant execute on function public.server_settle_generation_usage(uuid, uuid, text, jsonb, bigint)
to service_role;

-- --- 2. 访客生成：预留挂在 guard 上 ------------------------------------------------------------

create or replace function private.register_guest_cost_attempt(
  p_guard_id uuid,
  p_attempt_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare reservation uuid; attempt_id uuid;
begin
  select id into reservation
  from private.cost_reservations
  where guest_guard_id = p_guard_id and state in ('open', 'unknown');
  if reservation is null then
    raise exception using errcode = '22023', message = 'open guest cost reservation not found';
  end if;
  insert into private.cost_attempts (reservation_id, attempt_key)
  values (reservation, p_attempt_key)
  on conflict (attempt_key) do nothing
  returning id into attempt_id;
  if attempt_id is null then
    select id into attempt_id from private.cost_attempts where attempt_key = p_attempt_key;
  end if;
  return attempt_id;
end;
$$;

comment on function private.register_guest_cost_attempt(uuid, text)
is '发送访客供应商调用前幂等记录尝试，预留按 guest_guard_id 关联';
revoke execute on function private.register_guest_cost_attempt(uuid, text)
from public, anon, authenticated;
grant execute on function private.register_guest_cost_attempt(uuid, text) to service_role;

-- 这是 private.settle_cost_attempt 的访客孪生体：除了「按 guest_guard_id 而不是 job_id 关联预留」
-- 之外，校验、幂等与冲突语义必须逐条相同——重复结算且参数不一致时同样抛 23505，而不是静默覆盖。
-- 两者必须同步修改；tests/db/jobs-usage.test.ts 里有一条断言强制这一点。
create or replace function private.settle_guest_cost_attempt(
  p_guard_id uuid,
  p_attempt_key text,
  p_provider_operation_id text,
  p_usage jsonb,
  p_actual_micro_usd bigint
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare settled_attempt private.cost_attempts;
begin
  if p_actual_micro_usd < 0 or jsonb_typeof(p_usage) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid cost attempt settlement';
  end if;
  select attempt.* into settled_attempt
  from private.cost_attempts as attempt
  join private.cost_reservations as reservation on reservation.id = attempt.reservation_id
  where reservation.guest_guard_id = p_guard_id and attempt.attempt_key = p_attempt_key
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

comment on function private.settle_guest_cost_attempt(uuid, text, text, jsonb, bigint)
is '幂等结算一次访客供应商调用的实际用量与成本，语义与 private.settle_cost_attempt 逐条一致';
revoke execute on function private.settle_guest_cost_attempt(uuid, text, text, jsonb, bigint)
from public, anon, authenticated;
grant execute on function private.settle_guest_cost_attempt(uuid, text, text, jsonb, bigint)
to service_role;

-- 访客路径的两个 public 入口：与 S1 的写入包装器一致，内层已是 security definer 故用纯转调。

create or replace function public.server_register_guest_cost_attempt(
  p_guard_id uuid,
  p_attempt_key text
)
returns uuid
language sql
set search_path = ''
as $$
  select private.register_guest_cost_attempt(p_guard_id, p_attempt_key);
$$;

comment on function public.server_register_guest_cost_attempt(uuid, text)
is '服务端经 Data API 为访客生成幂等登记一次供应商调用尝试的受限入口';
revoke execute on function public.server_register_guest_cost_attempt(uuid, text)
from public, anon, authenticated;
grant execute on function public.server_register_guest_cost_attempt(uuid, text) to service_role;

create or replace function public.server_settle_guest_cost_attempt(
  p_guard_id uuid,
  p_attempt_key text,
  p_provider_operation_id text,
  p_usage jsonb,
  p_actual_micro_usd bigint
)
returns uuid
language sql
set search_path = ''
as $$
  select private.settle_guest_cost_attempt(
    p_guard_id, p_attempt_key, p_provider_operation_id, p_usage, p_actual_micro_usd
  );
$$;

comment on function public.server_settle_guest_cost_attempt(uuid, text, text, jsonb, bigint)
is '服务端经 Data API 结算一次访客供应商调用实测用量的受限入口';
revoke execute on function public.server_settle_guest_cost_attempt(uuid, text, text, jsonb, bigint)
from public, anon, authenticated;
grant execute on function public.server_settle_guest_cost_attempt(uuid, text, text, jsonb, bigint)
to service_role;
