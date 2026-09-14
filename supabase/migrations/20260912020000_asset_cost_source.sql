-- 路线图 S3：图片成本要么是**供应商报的**，要么就明说没报，不许中间态。
--
-- 改之前 src/trigger/generate-image.ts:53 与 src/trigger/visual-tool.ts:185 都写着
-- `providerCostUsd ?? 0.025`：APIMart 没回报成本时，代码就把 $0.025 这个凭空来的常数写进
-- private.ai_asset_reservations.actual_micro_usd。落库之后它和真实回报的成本长得一模一样，
-- 谁也分不出哪笔是实测、哪笔是编的——而账本正是拿来判断预算够不够的东西。
--
-- 这次的做法：
--   1. 加 cost_source 列，逐行记下这笔钱的来历；
--   2. p_actual_micro_usd 允许传 null，含义是「供应商没报」。此时**按预留全额入账**，
--      不按 $0.025 猜。预留是这次调用之前就已经从预算里扣掉的额度，拿它入账既不凭空造数，
--      方向也保守（宁可显得花得更多，不会让预算显得比实际宽松）。
--
-- 为什么不干脆记 0：记 0 等于宣称这次调用免费，会让预算显得比实际宽松，正好是最危险的方向。

alter table private.ai_asset_reservations
  add column if not exists cost_source text
    check (cost_source is null or cost_source in ('measured', 'unmeasured_reserved'));

comment on column private.ai_asset_reservations.cost_source
is 'actual_micro_usd 的来历：measured=供应商回报的真实成本；unmeasured_reserved=供应商未回报，按预留全额保守入账；null=未结算或已释放';

create or replace function public.server_finalize_ai_asset_candidate(
  p_asset_id uuid, p_owner_id uuid, p_succeeded boolean,
  p_provider_operation_id text, p_actual_micro_usd bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  reservation private.ai_asset_reservations;
  expected_state public.asset_state;
  charged_micro_usd bigint;
  charged_source text;
begin
  select * into reservation from private.ai_asset_reservations
  where asset_id = p_asset_id and owner_id = p_owner_id for update;
  if reservation.asset_id is null then raise exception using errcode = '42501', message = 'AI candidate reservation unavailable'; end if;
  if reservation.state in ('settled', 'released') then
    return jsonb_build_object('outcome', reservation.state::text);
  end if;
  expected_state := case when p_succeeded then 'ready'::public.asset_state else 'failed'::public.asset_state end;
  if p_actual_micro_usd < 0 or not exists (
    select 1 from public.assets where id = p_asset_id and owner_id = p_owner_id and state = expected_state
  ) then raise exception using errcode = '22023', message = 'AI candidate terminal state mismatch'; end if;
  -- null 表示供应商没回报成本：按预留全额保守入账，并把这件事记进 cost_source。
  charged_micro_usd := coalesce(p_actual_micro_usd, reservation.reserved_micro_usd);
  charged_source := case when p_actual_micro_usd is null then 'unmeasured_reserved' else 'measured' end;
  update public.usage_accounts set reserved = reserved - 1,
    consumed = consumed + case when p_succeeded then 1 else 0 end, updated_at = now()
  where id = reservation.account_id and reserved >= 1;
  if not found then raise exception using errcode = '22003', message = 'AI image quota invariant failed'; end if;
  insert into public.usage_ledger(account_id, event_key, kind, units)
  values(reservation.account_id, 'asset:' || p_asset_id::text || ':finalize',
    case when p_succeeded then 'settle'::public.usage_ledger_kind else 'release'::public.usage_ledger_kind end, 1);
  update private.cost_budgets set
    reserved_micro_usd = reserved_micro_usd - reservation.reserved_micro_usd,
    spent_micro_usd = spent_micro_usd + case when p_succeeded then charged_micro_usd else 0 end,
    updated_at = now()
  where period = reservation.period and environment = reservation.environment
    and reserved_micro_usd >= reservation.reserved_micro_usd;
  if not found then raise exception using errcode = '22003', message = 'AI image budget invariant failed'; end if;
  update private.ai_asset_reservations set
    actual_micro_usd = case when p_succeeded then charged_micro_usd else 0 end,
    cost_source = case when p_succeeded then charged_source else null end,
    provider_operation_id = p_provider_operation_id,
    state = case when p_succeeded then 'settled'::private.cost_reservation_state else 'released'::private.cost_reservation_state end,
    updated_at = now()
  where asset_id = p_asset_id;
  return jsonb_build_object(
    'outcome', case when p_succeeded then 'settled' else 'released' end,
    'costSource', case when p_succeeded then charged_source else null end);
end $$;

comment on function public.server_finalize_ai_asset_candidate(uuid, uuid, boolean, text, bigint)
is '按素材终态幂等结算图片额度与供应商成本；p_actual_micro_usd 传 null 表示供应商未回报成本，按预留全额保守入账并记为 unmeasured_reserved；失败时释放全部预留';
revoke execute on function public.server_finalize_ai_asset_candidate(uuid, uuid, boolean, text, bigint) from public, anon, authenticated;
grant execute on function public.server_finalize_ai_asset_candidate(uuid, uuid, boolean, text, bigint) to service_role;

-- 读取图片成本来历分布的受限入口：让「有多少笔是编的」这个问题可以被直接问到，
-- 而不是靠翻代码猜。与 S1 的读函数一致，只对 service_role 开放。
create or replace function public.server_sample_asset_cost_sources(p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  select coalesce(jsonb_agg(row_to_json(sample)), '[]'::jsonb) into result
  from (
    select cost_source, state::text as state, count(*) as rows,
           sum(actual_micro_usd) as actual_micro_usd_total,
           sum(reserved_micro_usd) as reserved_micro_usd_total
    from private.ai_asset_reservations
    group by cost_source, state
    order by count(*) desc
    limit greatest(coalesce(p_limit, 20), 1)
  ) as sample;
  return result;
end $$;

comment on function public.server_sample_asset_cost_sources(integer)
is '服务端按成本来历与预留状态汇总 AI 素材记账，用于核对有多少笔成本不是供应商实测';
revoke execute on function public.server_sample_asset_cost_sources(integer) from public, anon, authenticated;
grant execute on function public.server_sample_asset_cost_sources(integer) to service_role;
