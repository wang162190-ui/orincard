-- S6：把「预留」这一层的两个缺口补上。S1–S3 打通的是**尝试层**（cost_attempts）；
-- 真正把额度从 reserved 挪到 spent 的是 private.finalize_job，而它按 job_id 找预留。
-- 两个后果，S4 的实测验收里逐条量到过：
--
--   1. 访客生成的预留挂在 guest_guard_id 上、job_id 为 null，finalize_job 永远查不到它。
--      public.server_finish_guest_generation 又无条件把预留翻成 'unknown'，于是每跑一次
--      访客生成就多卡死 $0.002，而真实花掉的钱一分也进不了 spent。
--   2. 历史上还有 18 条预留卡在 open/unknown（$1.223），全部是「供应商调用已发出、
--      用量从没回报过」——它们没有任何可结算的实测数字，却永远占着当月额度，
--      使对账巡检的 unsettledReservations 永远非零，告警因此永远是红的、不再有意义。
--
-- 这里补三件东西：审计来源列、访客预留的结算入口、陈旧预留的显式核销入口。
-- 不新建表，不放宽任何 grant。

-- --- 1. 结算来源：让「实测结算」和「按预留核销」在库里可分辨 --------------------------------
-- 这条和 S3 给 private.ai_asset_reservations 加 cost_source 是同一个理由：
-- 一旦两种来源的行长得一模一样，账本就不能再回答「这个数字是量出来的还是兜底的」。

alter table private.cost_reservations
  add column if not exists settlement_source text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'cost_reservations_settlement_source_check'
  ) then
    alter table private.cost_reservations
      add constraint cost_reservations_settlement_source_check
      check (settlement_source is null or settlement_source in ('measured', 'unmeasured_reserved'));
  end if;
end;
$$;

comment on column private.cost_reservations.settlement_source is
  'measured=按已结算尝试的实测用量入账；unmeasured_reserved=供应商从未回报用量，按预留额保守全额核销；null=尚未结算';

-- --- 2. 访客预留的结算入口：private.finalize_job 的访客孪生体 ---------------------------------
-- 只做 finalize_job 里「成本预留」那一半：不碰 usage_ledger（访客不占席位额度），
-- 不碰 public.jobs（访客没有 job 行）。审计条件与 finalize_job 逐条一致：
-- 有尝试仍处于 sent/unknown 就不结算，因为那意味着还有钱可能在路上。

create or replace function private.finalize_guest_reservation(p_guard_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare reservation private.cost_reservations; actual bigint; outstanding integer;
begin
  select * into reservation
  from private.cost_reservations
  where guest_guard_id = p_guard_id and state in ('open', 'unknown')
  for update;
  if reservation.id is null then
    return null;
  end if;

  select count(*) into outstanding
  from private.cost_attempts
  where reservation_id = reservation.id and state in ('sent', 'unknown');
  if outstanding > 0 then
    -- 还有调用没回报，现在结算会把在途的钱记成 0。交给调用方走保守回退。
    return null;
  end if;

  select coalesce(sum(actual_micro_usd), 0) into actual
  from private.cost_attempts
  where reservation_id = reservation.id and state = 'settled';
  if not exists (select 1 from private.cost_attempts where reservation_id = reservation.id) then
    -- 一条尝试都没有：无法区分「没花钱」和「花了但没登记」。不猜，走保守回退。
    return null;
  end if;

  -- 实测成本可以高于预留（S4 实测：访客预留 $0.002，实际 $0.004910，少预留 2.46 倍）。
  -- 此时 released 为 0，spent 按实际加，预算净额如实收紧——这正是预留开小了的代价该有的样子。
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

comment on function private.finalize_guest_reservation(uuid) is
  '按 guest_guard_id 结算访客成本预留：审计通过则把 reserved 挪进 spent，否则返回 null 由调用方保守处理';
revoke execute on function private.finalize_guest_reservation(uuid) from public, anon, authenticated;
grant execute on function private.finalize_guest_reservation(uuid) to service_role;

-- --- 3. 让访客收尾真的结算，审计不过再退回原来的保守行为 --------------------------------------
-- 原实现（20260907002243_b04.sql:257）无条件把预留翻 'unknown'。那在当时是对的：
-- 那时候访客路径根本没有任何结算数据。S2 接线之后数据有了，就不该再一律兜底。
-- 兜底分支**原样保留**：审计不过时仍然翻 'unknown'，宁可卡住额度也不记成 0。

create or replace function public.server_finish_guest_generation(p_guard_id uuid, p_outcome text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare guard_updated boolean; settled bigint;
begin
  if p_outcome not in ('succeeded', 'failed') then
    raise exception using errcode = '22023', message = 'invalid guest outcome';
  end if;
  update private.request_guards set state = p_outcome where id = p_guard_id and state = 'processing';
  guard_updated := found;

  settled := private.finalize_guest_reservation(p_guard_id);
  if settled is null then
    update private.cost_reservations set state = 'unknown', updated_at = now()
    where guest_guard_id = p_guard_id and state = 'open';
  end if;

  return guard_updated;
end;
$$;

comment on function public.server_finish_guest_generation(uuid, text) is
  '服务端终结匿名请求元数据；能审计到实测用量时结算成本预留，审计不过则保守保持成本占用';
revoke execute on function public.server_finish_guest_generation(uuid, text) from public, anon, authenticated;
grant execute on function public.server_finish_guest_generation(uuid, text) to service_role;

-- --- 4. 陈旧预留的显式核销 --------------------------------------------------------------------
-- 这些预留对应的供应商调用**已经发出**（每条都有一行 sent/unknown 的尝试，或者根本没来得及登记），
-- 钱大概率已经花掉，只是没人回报花了多少。两条错误的处置方式：
--   · 直接 release —— 等于宣称这次调用免费。这是最危险的方向，会把额度放回去让人继续花。
--   · 编一个数字 —— S3 已经因为 $0.025 这个常数否掉过一次。
-- 采用的是 S3 给图片资产定下的同一条policy：**按预留额全额保守入账**，并记 unmeasured_reserved。
-- 预留额是花钱之前就已经从预算里扣掉的上界，用它入账不凭空造数，方向只会让预算显得更紧。
--
-- 刻意**不**放进 retention 定时任务：预留是钱，5 分钟没结算就自动核销会把本可回收的额度烧掉。
-- 巡检只负责报数，核销是需要人看一眼的显式动作。p_min_age 是防手滑的第二道闸。

create or replace function private.write_off_stale_reservation(
  p_reservation_id uuid,
  p_min_age interval
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare reservation private.cost_reservations; charged bigint;
begin
  select * into reservation
  from private.cost_reservations
  where id = p_reservation_id and state in ('open', 'unknown')
  for update;
  if reservation.id is null then
    raise exception using errcode = '22023', message = 'no open reservation to write off';
  end if;
  if reservation.updated_at >= now() - p_min_age then
    raise exception using errcode = '22023', message = 'reservation is not stale enough to write off';
  end if;

  -- 已有实测结算高于预留时按实测走，避免核销反而少记钱。
  select greatest(reservation.reserved_micro_usd, coalesce(sum(actual_micro_usd), 0)) into charged
  from private.cost_attempts
  where reservation_id = reservation.id and state = 'settled';

  update private.cost_budgets
  set reserved_micro_usd = reserved_micro_usd - reservation.reserved_micro_usd,
      spent_micro_usd = spent_micro_usd + charged,
      updated_at = now()
  where period = reservation.period and environment = reservation.environment
    and reserved_micro_usd >= reservation.reserved_micro_usd;
  if not found then
    raise exception using errcode = '22003', message = 'cost budget invariant failed';
  end if;

  update private.cost_reservations
  set settled_micro_usd = charged,
      released_micro_usd = 0,
      state = 'settled',
      settlement_source = 'unmeasured_reserved',
      updated_at = now()
  where id = reservation.id;

  return charged;
end;
$$;

comment on function private.write_off_stale_reservation(uuid, interval) is
  '把供应商从未回报用量的陈旧预留按预留额全额核销进 spent，并标记 unmeasured_reserved';
revoke execute on function private.write_off_stale_reservation(uuid, interval) from public, anon, authenticated;
grant execute on function private.write_off_stale_reservation(uuid, interval) to service_role;

create or replace function public.server_write_off_stale_reservation(
  p_reservation_id uuid,
  p_min_age_hours integer
)
returns bigint
language sql
set search_path = ''
as $$
  select private.write_off_stale_reservation(
    p_reservation_id,
    make_interval(hours => greatest(p_min_age_hours, 1))
  );
$$;

comment on function public.server_write_off_stale_reservation(uuid, integer) is
  '服务端核销一条陈旧成本预留的受限入口；最小陈旧时长下限为 1 小时';
revoke execute on function public.server_write_off_stale_reservation(uuid, integer) from public, anon, authenticated;
grant execute on function public.server_write_off_stale_reservation(uuid, integer) to service_role;

-- --- 5. 巡检要能看清「哪一条卡住了、卡了多久、有没有可结算的实测数字」 ------------------------
-- server_count_unsettled_reservations 只给一个数字，光看数字没法决定该结算还是该核销。

create or replace function public.server_list_stale_reservations(
  p_before timestamptz,
  p_limit integer
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_json order by reserved_micro_usd desc), '[]'::jsonb)
  from (
    select
      reservation.reserved_micro_usd,
      jsonb_build_object(
        'id', reservation.id,
        'subject', case when reservation.guest_guard_id is not null then 'guest' else 'job' end,
        'period', reservation.period,
        'environment', reservation.environment,
        'state', reservation.state,
        'reservedMicroUsd', reservation.reserved_micro_usd,
        'updatedAt', reservation.updated_at,
        'attemptCount', (
          select count(*) from private.cost_attempts
          where reservation_id = reservation.id
        ),
        'outstandingAttempts', (
          select count(*) from private.cost_attempts
          where reservation_id = reservation.id and state in ('sent', 'unknown')
        ),
        'settledMicroUsd', coalesce((
          select sum(actual_micro_usd) from private.cost_attempts
          where reservation_id = reservation.id and state = 'settled'
        ), 0)
      ) as row_json
    from private.cost_reservations as reservation
    where reservation.state in ('open', 'unknown')
      and reservation.updated_at < p_before
    order by reservation.reserved_micro_usd desc
    limit greatest(p_limit, 0)
  ) as rows;
$$;

comment on function public.server_list_stale_reservations(timestamptz, integer) is
  '对账巡检用：列出陈旧未结算预留及其尝试审计状态，只回报金额与计数，不含任何正文';
revoke execute on function public.server_list_stale_reservations(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.server_list_stale_reservations(timestamptz, integer) to service_role;
