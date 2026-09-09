create table if not exists private.ai_asset_reservations (
  asset_id uuid primary key references public.assets(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  account_id uuid not null references public.usage_accounts(id) on delete restrict,
  environment text not null check (environment in ('development', 'preview', 'production')),
  period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  reserved_micro_usd bigint not null check (reserved_micro_usd >= 0),
  actual_micro_usd bigint,
  provider_operation_id text,
  state private.cost_reservation_state not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table private.ai_asset_reservations is 'AI 素材候选的用户额度与供应商成本原子预留';
comment on column private.ai_asset_reservations.asset_id is '候选素材标识与预留幂等键';
comment on column private.ai_asset_reservations.owner_id is '预留所有者标识';
comment on column private.ai_asset_reservations.account_id is '被预留的图片额度桶';
comment on column private.ai_asset_reservations.environment is '成本预算部署环境';
comment on column private.ai_asset_reservations.period is '成本预算 UTC 月份';
comment on column private.ai_asset_reservations.reserved_micro_usd is '预估供应商成本，单位微美元';
comment on column private.ai_asset_reservations.actual_micro_usd is '最终供应商成本，单位微美元';
comment on column private.ai_asset_reservations.provider_operation_id is '供应商任务对账标识';
comment on column private.ai_asset_reservations.state is '开放、结算或释放状态';
comment on column private.ai_asset_reservations.created_at is '创建时间（UTC）';
comment on column private.ai_asset_reservations.updated_at is '最近修改时间（UTC）';
alter table private.ai_asset_reservations enable row level security;
revoke all on private.ai_asset_reservations from public, anon, authenticated, service_role;

create or replace function public.server_create_ai_asset_candidate(
  p_asset_id uuid, p_owner_id uuid, p_kind public.asset_kind, p_object_key text,
  p_rights jsonb, p_environment text, p_reserved_micro_usd bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare account public.usage_accounts; budget private.cost_budgets;
  period_key text := to_char(now() at time zone 'UTC', 'YYYY-MM');
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':ai-asset:' || p_asset_id::text, 0));
  if exists (select 1 from public.assets where id = p_asset_id and owner_id = p_owner_id) then
    return jsonb_build_object('outcome', 'created', 'assetId', p_asset_id);
  end if;
  if p_kind not in ('ai_image', 'portrait') or jsonb_typeof(p_rights) <> 'object'
    or p_object_key <> p_owner_id::text || '/' || p_asset_id::text || '/pending.png'
    or not exists (select 1 from public.profiles where id = p_owner_id and status = 'active') then
    raise exception using errcode = '42501', message = 'AI candidate is not accessible';
  end if;
  select * into account from public.usage_accounts
  where owner_id = p_owner_id and resource = 'image' and now() >= period_start and now() < period_end
  order by period_start desc limit 1 for update;
  if account.id is null or account.granted - account.reserved - account.consumed < 1 then
    return jsonb_build_object('outcome', 'quota_exceeded');
  end if;
  select * into budget from private.cost_budgets
  where period = period_key and environment = p_environment for update;
  if budget.period is null or p_reserved_micro_usd < 0
    or budget.limit_micro_usd - budget.reserved_micro_usd - budget.spent_micro_usd < p_reserved_micro_usd then
    return jsonb_build_object('outcome', 'budget_exceeded');
  end if;
  insert into public.assets(id, owner_id, kind, purpose, bucket, object_key, mime, bytes, sha256, rights, state, library_retained)
  values(p_asset_id, p_owner_id, p_kind, 'media', 'assets', p_object_key, 'image/png', 0, repeat('0',64), p_rights, 'pending_upload', false);
  update public.usage_accounts set reserved = reserved + 1, updated_at = now() where id = account.id;
  insert into public.usage_ledger(account_id, event_key, kind, units)
  values(account.id, 'asset:' || p_asset_id::text || ':reserve', 'reserve', 1);
  update private.cost_budgets set reserved_micro_usd = reserved_micro_usd + p_reserved_micro_usd, updated_at = now()
  where period = period_key and environment = p_environment;
  insert into private.ai_asset_reservations(asset_id, owner_id, account_id, environment, period, reserved_micro_usd)
  values(p_asset_id, p_owner_id, account.id, p_environment, period_key, p_reserved_micro_usd);
  return jsonb_build_object('outcome', 'created', 'assetId', p_asset_id);
end $$;
comment on function public.server_create_ai_asset_candidate(uuid, uuid, public.asset_kind, text, jsonb, text, bigint) is '在同一事务中创建 AI 素材候选并预留图片额度及供应商成本';
revoke execute on function public.server_create_ai_asset_candidate(uuid, uuid, public.asset_kind, text, jsonb, text, bigint) from public, anon, authenticated;
grant execute on function public.server_create_ai_asset_candidate(uuid, uuid, public.asset_kind, text, jsonb, text, bigint) to service_role;

create or replace function public.server_finalize_ai_asset_candidate(
  p_asset_id uuid, p_owner_id uuid, p_succeeded boolean,
  p_provider_operation_id text, p_actual_micro_usd bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare reservation private.ai_asset_reservations; expected_state public.asset_state;
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
  update public.usage_accounts set reserved = reserved - 1,
    consumed = consumed + case when p_succeeded then 1 else 0 end, updated_at = now()
  where id = reservation.account_id and reserved >= 1;
  if not found then raise exception using errcode = '22003', message = 'AI image quota invariant failed'; end if;
  insert into public.usage_ledger(account_id, event_key, kind, units)
  values(reservation.account_id, 'asset:' || p_asset_id::text || ':finalize',
    case when p_succeeded then 'settle'::public.usage_ledger_kind else 'release'::public.usage_ledger_kind end, 1);
  update private.cost_budgets set
    reserved_micro_usd = reserved_micro_usd - reservation.reserved_micro_usd,
    spent_micro_usd = spent_micro_usd + case when p_succeeded then p_actual_micro_usd else 0 end,
    updated_at = now()
  where period = reservation.period and environment = reservation.environment
    and reserved_micro_usd >= reservation.reserved_micro_usd;
  if not found then raise exception using errcode = '22003', message = 'AI image budget invariant failed'; end if;
  update private.ai_asset_reservations set
    actual_micro_usd = case when p_succeeded then p_actual_micro_usd else 0 end,
    provider_operation_id = p_provider_operation_id,
    state = case when p_succeeded then 'settled'::private.cost_reservation_state else 'released'::private.cost_reservation_state end,
    updated_at = now()
  where asset_id = p_asset_id;
  return jsonb_build_object('outcome', case when p_succeeded then 'settled' else 'released' end);
end $$;
comment on function public.server_finalize_ai_asset_candidate(uuid, uuid, boolean, text, bigint) is '按素材终态幂等结算图片额度与真实供应商成本，失败时释放全部预留';
revoke execute on function public.server_finalize_ai_asset_candidate(uuid, uuid, boolean, text, bigint) from public, anon, authenticated;
grant execute on function public.server_finalize_ai_asset_candidate(uuid, uuid, boolean, text, bigint) to service_role;

notify pgrst, 'reload schema';
