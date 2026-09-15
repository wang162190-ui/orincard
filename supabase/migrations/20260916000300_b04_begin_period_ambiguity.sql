-- 修一个**真实存在、一直在生效**的缺陷：private.b04_begin_ai_candidate_job 在预算查询处
-- 抛 42702「column reference "period" is ambiguous」。
--
-- 20260907002243_b04.sql:358 把局部变量取名 `period`，而 private.cost_budgets 正好有一列
-- 也叫 period。`where private.cost_budgets.period = period` 里左边限定了、右边没有，
-- PostgreSQL 无法判定右边那个 period 是变量还是列，于是**每一次**走到这一行都直接异常。
--
-- 影响范围是所有经由该函数预留的同步 AI 链路：rewrite 候选、regenerate 候选，
-- 以及本轮新接的 copilot 对话轮。表现是一律 503（调用方把 RPC 异常统一当成服务不可用），
-- 不是「额度不足」也不是「预算不足」——账目本身没问题，是这一行根本执行不到。
-- 单元测试看不见它：那一层用的是假 store，真正的 SQL 从来没有在测试里被执行过。
-- 发现于 T099 的真实浏览器验收（2026-09-16），那是第一条真的把这条 RPC 跑起来的测试。
--
-- 修法是最小的：变量改名 period_key（与同库其它函数一致，如 server_create_ai_asset_candidate），
-- 函数体其余部分与 20260907002243_b04.sql 逐字相同，账目语义一个字都没动。
create or replace function private.b04_begin_ai_candidate_job(
  p_owner_id uuid, p_project_id uuid, p_kind public.job_kind, p_input_ref jsonb,
  p_idempotency_key text, p_request_hash text, p_environment text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare existing public.jobs; account public.usage_accounts; budget private.cost_budgets; created public.jobs; period_key text := to_char(now() at time zone 'UTC', 'YYYY-MM');
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
  select * into budget from private.cost_budgets where private.cost_budgets.period = period_key and environment = p_environment for update;
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
  where private.cost_budgets.period = period_key and environment = p_environment;
  insert into private.cost_reservations (job_id, environment, period, operation_key, reserved_micro_usd)
  values (created.id, p_environment, period_key, 'job:' || created.id::text, 25000);
  insert into private.cost_attempts (reservation_id, attempt_key, state)
  select id, 'job:' || created.id::text || ':candidate:1', 'sent' from private.cost_reservations where job_id = created.id;
  return jsonb_build_object('outcome', 'accepted', 'jobId', created.id);
end;
$$;

comment on function private.b04_begin_ai_candidate_job(uuid, uuid, public.job_kind, jsonb, text, text, text) is '为同步 AI 候选原子预留一次额度与保守供应商成本且不携带正文输入';
revoke execute on function private.b04_begin_ai_candidate_job(uuid, uuid, public.job_kind, jsonb, text, text, text) from public, anon, authenticated;
