-- 把 S6 为访客路径定下的「有实测数据就精确结算」补到工具 job 上。
--
-- 20260915002000_tool_job_finalize.sql 引入的 public.server_finalize_tool_job 无条件走
-- private.b04_finish_job_with_unknown_cost，于是每跑一次文本工具就多一条 'unknown' 预留
-- 永远占着当月成本额度。这正是 S6 头注里量过的那个坑（18 条预留、$1.223、告警永远是红的），
-- 当时只在访客那一侧堵上了。
--
-- 工具 worker 其实有实测数字：src/trigger/tool.ts 在 generate 的 finally 里
-- settleKeyedJobUsage，**先于** succeed/fail，所以收尾那一刻尝试行已经是 'settled'。
-- 无条件兜底等于把量到的钱扔掉。
--
-- 只改工具这一条链路。server_finalize_generation_job / server_complete_rewrite_proposal /
-- server_complete_regeneration_candidate 有同样的缺口，但那是先于本轮的系统性问题，
-- 一起改会把爆炸半径扩到本轮没验证过的三条链路上——留给它们各自的验收。

-- --- 1. private.finalize_job_reservation：finalize_guest_reservation 的 job 孪生体 ----------
-- 与访客版逐条同构，只差查找键（job_id 而非 guest_guard_id）。同样只做「成本预留」那一半：
-- usage_ledger / public.jobs 仍由 b04 收尾，两边职责不重叠。
--
-- 为什么不直接用 private.finalize_job：它要调用方自己把 p_actual_micro_usd 报准（对不上就
-- 22003），还要求 lease_token 匹配。收尾方从库里读出来的数字再喂回库里做等值校验，是多余的
-- 一次往返，而 claim 期失败路径根本没有 lease。

create or replace function private.finalize_job_reservation(p_job_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare reservation private.cost_reservations; actual bigint; outstanding integer;
begin
  select * into reservation
  from private.cost_reservations
  where job_id = p_job_id and state in ('open', 'unknown')
  for update;
  if reservation.id is null then
    return null;
  end if;

  select count(*) into outstanding
  from private.cost_attempts
  where reservation_id = reservation.id and state in ('sent', 'unknown');
  if outstanding > 0 then
    -- 还有调用没回报用量，现在结算会把在途的钱记成 0。交给调用方走保守回退。
    return null;
  end if;

  if not exists (select 1 from private.cost_attempts where reservation_id = reservation.id) then
    -- 一条尝试都没有：分不清「没花钱」和「花了但没登记」。不猜，走保守回退。
    return null;
  end if;

  select coalesce(sum(actual_micro_usd), 0) into actual
  from private.cost_attempts
  where reservation_id = reservation.id and state = 'settled';

  -- 实测可以高于预留：此时 released 为 0，spent 按实际加，预算净额如实收紧。
  update private.cost_budgets
  set reserved_micro_usd = reserved_micro_usd - reservation.reserved_micro_usd,
      spent_micro_usd = spent_micro_usd + actual,
      updated_at = now()
  where period = reservation.period and environment = reservation.environment
    and reserved_micro_usd >= reservation.reserved_micro_usd;
  if not found then
    raise exception using errcode = '22003', message = 'cost budget invariant failed';
  end if;

  update private.cost_reservations
  set settled_micro_usd = actual,
      released_micro_usd = greatest(reservation.reserved_micro_usd - actual, 0),
      state = case when actual > 0 then 'settled'::private.cost_reservation_state
                   else 'released'::private.cost_reservation_state end,
      settlement_source = 'measured',
      updated_at = now()
  where id = reservation.id;

  return actual;
end;
$$;

comment on function private.finalize_job_reservation(uuid) is
  '按 job_id 结算成本预留：审计通过则把 reserved 挪进 spent，否则返回 null 由调用方保守处理';
revoke execute on function private.finalize_job_reservation(uuid) from public, anon, authenticated;
grant execute on function private.finalize_job_reservation(uuid) to service_role;

-- --- 2. 工具收尾先精确结算，再交给 b04 收用量和终态 ------------------------------------------
-- b04 的成本那一段只动 `state = 'open'` 的预留和 `planned/sent` 的尝试。先结算完，
-- 它在成本侧自然变成 no-op，用量结算与 jobs 终态照旧由它一手完成，不必复制。
-- 审计不过时什么都不结算，b04 照旧翻 'unknown'——兜底分支**原样保留**，宁可卡住额度也不记成 0。

create or replace function public.server_finalize_tool_job(
  p_job_id uuid, p_owner_id uuid, p_result_ref jsonb, p_error_code text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare target public.jobs;
begin
  select * into target from public.jobs
  where id = p_job_id and owner_id = p_owner_id and kind = 'tool' for update;
  if target.id is null then return false; end if;
  -- 重复收尾是正常结果（Trigger 重试）：如实回报既有终态，不再动账。
  if target.state in ('succeeded', 'partial', 'failed', 'canceled') then
    return target.state = 'succeeded';
  end if;
  if (p_result_ref is null) = (p_error_code is null) then
    raise exception using errcode = '22023', message = 'exactly one tool result is required';
  end if;

  -- 失败也要精确结算：token 已经烧掉了，worker 的 settleKeyedJobUsage 在 finally 里报过数。
  perform private.finalize_job_reservation(p_job_id);

  -- 未派发/排队态也收在这里：claim 阶段的 CONTEXT_UNAVAILABLE 同样必须释放预留。
  perform private.b04_finish_job_with_unknown_cost(
    p_job_id, p_error_code is null, p_result_ref, p_error_code
  );
  return p_error_code is null and target.cancel_requested_at is null;
end;
$$;

comment on function public.server_finalize_tool_job(uuid, uuid, jsonb, text) is
  '服务端终结文本/视觉工具任务：能审计到实测用量时精确结算成本预留，审计不过则保守保持成本占用';
revoke execute on function public.server_finalize_tool_job(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.server_finalize_tool_job(uuid, uuid, jsonb, text) to service_role;
