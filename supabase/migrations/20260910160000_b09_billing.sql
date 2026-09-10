-- T069 billing database model.
do $$
begin
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'billing_plan_key') then
    create type public.billing_plan_key as enum ('free', 'pro', 'creator');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'subscription_status') then
    create type public.subscription_status as enum ('incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'private'::regnamespace and typname = 'billing_event_status') then
    create type private.billing_event_status as enum ('received', 'processing', 'applied', 'failed');
  end if;
end
$$;

comment on type public.billing_plan_key is '服务端权益策略中的产品档位';
comment on type public.subscription_status is '支付供应商订阅生命周期镜像';
comment on type private.billing_event_status is '已验签账单事件的处理状态';

create table if not exists public.billing_customers (
  owner_id uuid not null references auth.users (id) on delete restrict,
  environment text not null check (environment in ('test', 'live')),
  provider_customer_id text not null unique check (length(btrim(provider_customer_id)) between 1 and 255),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, environment)
);

comment on table public.billing_customers is '服务端维护的账户与支付供应商 customer 映射';
comment on column public.billing_customers.owner_id is '支付客户映射所属账户';
comment on column public.billing_customers.environment is '严格隔离的 Stripe test 或 live 环境';
comment on column public.billing_customers.provider_customer_id is 'Stripe Customer 标识，不是支付凭证';
comment on column public.billing_customers.created_at is '首次建立映射时间（UTC）';
comment on column public.billing_customers.updated_at is '映射最近更新时间（UTC）';

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users (id) on delete restrict,
  provider_customer_id text not null unique check (length(btrim(provider_customer_id)) between 1 and 255),
  provider_subscription_id text not null unique check (length(btrim(provider_subscription_id)) between 1 and 255),
  plan_key public.billing_plan_key not null,
  policy_version text not null check (length(btrim(policy_version)) between 1 and 100),
  status public.subscription_status not null,
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  provider_updated_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint subscriptions_period_check check (current_period_end > current_period_start)
);

comment on table public.subscriptions is '不含支付凭证的当前供应商订阅镜像';
comment on column public.subscriptions.id is '订阅镜像唯一标识';
comment on column public.subscriptions.owner_id is '订阅账户所有者';
comment on column public.subscriptions.provider_customer_id is 'Stripe Customer 标识，不是支付凭证';
comment on column public.subscriptions.provider_subscription_id is 'Stripe Subscription 唯一标识';
comment on column public.subscriptions.plan_key is '由服务端价格映射得到的产品档位';
comment on column public.subscriptions.policy_version is '本周期权益策略版本';
comment on column public.subscriptions.status is '供应商当前订阅状态';
comment on column public.subscriptions.current_period_start is '当前付费周期开始时间（UTC）';
comment on column public.subscriptions.current_period_end is '当前付费周期结束时间（UTC）';
comment on column public.subscriptions.cancel_at_period_end is '是否已安排在当前周期结束时取消';
comment on column public.subscriptions.provider_updated_at is '供应商对象最后更新时间，用于乱序收敛';
comment on column public.subscriptions.updated_at is '本地镜像最近更新时间（UTC）';

create table if not exists private.billing_events (
  provider_event_id text primary key check (length(btrim(provider_event_id)) between 1 and 255),
  type text not null check (length(btrim(type)) between 1 and 200),
  subject_id text not null check (length(btrim(subject_id)) between 1 and 255),
  status private.billing_event_status not null default 'received',
  attempt integer not null default 0 check (attempt >= 0),
  error_code text,
  received_at timestamptz not null default now(),
  applied_at timestamptz,
  constraint billing_events_applied_check check ((status = 'applied' and applied_at is not null) or (status <> 'applied' and applied_at is null))
);

comment on table private.billing_events is '已验签且不含完整支付 payload 的幂等事件收件箱';
comment on column private.billing_events.provider_event_id is '供应商事件唯一标识和幂等键';
comment on column private.billing_events.type is '受理的供应商事件类型';
comment on column private.billing_events.subject_id is '订阅或账单等供应商业务主体标识';
comment on column private.billing_events.status is '接收、处理、已应用或失败状态';
comment on column private.billing_events.attempt is '处理领取次数';
comment on column private.billing_events.error_code is '不含供应商 payload 的安全错误码';
comment on column private.billing_events.received_at is '首次验签接收时间（UTC）';
comment on column private.billing_events.applied_at is '业务变更提交时间（UTC）';

create table if not exists private.billing_audit_log (
  id uuid primary key default gen_random_uuid(),
  provider_event_id text not null unique references private.billing_events (provider_event_id) on delete restrict,
  owner_id uuid not null references auth.users (id) on delete restrict,
  provider_invoice_id text,
  action text not null check (length(btrim(action)) between 1 and 100),
  details jsonb not null default '{}'::jsonb check (
    jsonb_typeof(details) = 'object'
    and not (details ?| array['card', 'payment_method', 'client_secret', 'api_key', 'payload'])
  ),
  created_at timestamptz not null default now()
);

comment on table private.billing_audit_log is '按事件追加的脱敏账单业务变更审计';
comment on column private.billing_audit_log.id is '审计记录唯一标识';
comment on column private.billing_audit_log.provider_event_id is '形成该审计记录的唯一供应商事件';
comment on column private.billing_audit_log.owner_id is '受业务变更影响的账户';
comment on column private.billing_audit_log.provider_invoice_id is '可选账单标识，不按时间近似合并不同账单';
comment on column private.billing_audit_log.action is '订阅同步、授权、反冲或账单动作';
comment on column private.billing_audit_log.details is '不含卡号、密钥和完整 payload 的安全摘要';
comment on column private.billing_audit_log.created_at is '业务变更审计时间（UTC）';

create index if not exists subscriptions_status_period_idx on public.subscriptions (status, current_period_end);
create index if not exists billing_events_status_received_idx on private.billing_events (status, received_at);
create index if not exists billing_audit_owner_created_idx on private.billing_audit_log (owner_id, created_at desc);
create index if not exists billing_audit_invoice_idx on private.billing_audit_log (provider_invoice_id) where provider_invoice_id is not null;

create or replace function public.server_register_billing_event(p_provider_event_id text, p_type text, p_subject_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if length(btrim(p_provider_event_id)) not between 1 and 255 or length(btrim(p_type)) not between 1 and 200 or length(btrim(p_subject_id)) not between 1 and 255 then
    raise exception using errcode = '22023', message = 'invalid billing event metadata';
  end if;
  insert into private.billing_events (provider_event_id, type, subject_id)
  values (p_provider_event_id, p_type, p_subject_id) on conflict (provider_event_id) do nothing;
  return found;
end;
$$;
comment on function public.server_register_billing_event(text, text, text) is '在验签后以供应商 event ID 幂等登记脱敏事件';
revoke execute on function public.server_register_billing_event(text, text, text) from public, anon, authenticated;
grant execute on function public.server_register_billing_event(text, text, text) to service_role;

create or replace function public.server_claim_billing_event(p_provider_event_id text)
returns table(provider_event_id text, type text, subject_id text, attempt integer) language plpgsql security definer set search_path = '' as $$
begin
  return query update private.billing_events event
  set status = 'processing', attempt = event.attempt + 1, error_code = null
  where event.provider_event_id = p_provider_event_id and event.status in ('received', 'failed')
  returning event.provider_event_id, event.type, event.subject_id, event.attempt;
end;
$$;
comment on function public.server_claim_billing_event(text) is '原子领取一个未应用或可重试的已验签账单事件';
revoke execute on function public.server_claim_billing_event(text) from public, anon, authenticated;
grant execute on function public.server_claim_billing_event(text) to service_role;

create or replace function public.server_apply_billing_event(
  p_provider_event_id text, p_owner_id uuid, p_provider_customer_id text, p_provider_subscription_id text,
  p_plan_key public.billing_plan_key, p_policy_version text, p_status public.subscription_status,
  p_current_period_start timestamptz, p_current_period_end timestamptz, p_cancel_at_period_end boolean,
  p_provider_updated_at timestamptz, p_provider_invoice_id text, p_action text, p_details jsonb
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare event private.billing_events;
begin
  select * into event from private.billing_events where provider_event_id = p_provider_event_id for update;
  if event.provider_event_id is null then raise exception using errcode = '42501', message = 'billing event is not registered'; end if;
  if event.status = 'applied' then return false; end if;
  if event.status <> 'processing' then raise exception using errcode = '55000', message = 'billing event is not claimed'; end if;
  if not exists (select 1 from public.profiles where id = p_owner_id and status = 'active')
    or p_current_period_end <= p_current_period_start or jsonb_typeof(p_details) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid subscription snapshot';
  end if;
  insert into public.subscriptions (owner_id, provider_customer_id, provider_subscription_id, plan_key, policy_version, status, current_period_start, current_period_end, cancel_at_period_end, provider_updated_at)
  values (p_owner_id, p_provider_customer_id, p_provider_subscription_id, p_plan_key, p_policy_version, p_status, p_current_period_start, p_current_period_end, p_cancel_at_period_end, p_provider_updated_at)
  on conflict (owner_id) do update set
    provider_customer_id = excluded.provider_customer_id, provider_subscription_id = excluded.provider_subscription_id,
    plan_key = excluded.plan_key, policy_version = excluded.policy_version, status = excluded.status,
    current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end, provider_updated_at = excluded.provider_updated_at, updated_at = now()
  where subscriptions.provider_updated_at <= excluded.provider_updated_at;
  insert into private.billing_audit_log (provider_event_id, owner_id, provider_invoice_id, action, details)
  values (p_provider_event_id, p_owner_id, p_provider_invoice_id, p_action, p_details);
  update private.billing_events set status = 'applied', applied_at = now(), error_code = null where provider_event_id = p_provider_event_id;
  return true;
end;
$$;
comment on function public.server_apply_billing_event(text, uuid, text, text, public.billing_plan_key, text, public.subscription_status, timestamptz, timestamptz, boolean, timestamptz, text, text, jsonb) is '幂等应用已领取事件，以供应商更新时间收敛订阅乱序并追加独立账单审计';
revoke execute on function public.server_apply_billing_event(text, uuid, text, text, public.billing_plan_key, text, public.subscription_status, timestamptz, timestamptz, boolean, timestamptz, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.server_apply_billing_event(text, uuid, text, text, public.billing_plan_key, text, public.subscription_status, timestamptz, timestamptz, boolean, timestamptz, text, text, jsonb) to service_role;

create or replace function public.server_fail_billing_event(p_provider_event_id text, p_error_code text)
returns boolean language sql security definer set search_path = '' as $$
  update private.billing_events set status = 'failed', error_code = left(p_error_code, 100), applied_at = null
  where provider_event_id = p_provider_event_id and status = 'processing' returning true;
$$;
comment on function public.server_fail_billing_event(text, text) is '将处理中事件标为可重试失败且仅保存安全错误码';
revoke execute on function public.server_fail_billing_event(text, text) from public, anon, authenticated;
grant execute on function public.server_fail_billing_event(text, text) to service_role;

create or replace function private.reject_billing_audit_mutation()
returns trigger language plpgsql set search_path = '' as $$ begin raise exception using errcode = '55000', message = 'billing audit is append only'; end; $$;
comment on function private.reject_billing_audit_mutation() is '阻止账单审计记录更新或删除';
revoke execute on function private.reject_billing_audit_mutation() from public, anon, authenticated, service_role;
drop trigger if exists billing_audit_is_append_only on private.billing_audit_log;
create trigger billing_audit_is_append_only before update or delete on private.billing_audit_log for each row execute function private.reject_billing_audit_mutation();

alter table public.subscriptions enable row level security;
alter table public.billing_customers enable row level security;
alter table private.billing_events enable row level security;
alter table private.billing_audit_log enable row level security;
revoke all on table public.subscriptions from anon, authenticated, service_role;
revoke all on table public.billing_customers from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.billing_customers to service_role;
grant select (id, plan_key, policy_version, status, current_period_start, current_period_end, cancel_at_period_end, updated_at) on table public.subscriptions to authenticated;
grant select, insert, update, delete on table public.subscriptions to service_role;
revoke all on table private.billing_events, private.billing_audit_log from public, anon, authenticated, service_role;
drop policy if exists subscriptions_select_own_active on public.subscriptions;
create policy subscriptions_select_own_active on public.subscriptions for select to authenticated using (
  owner_id = (select auth.uid()) and exists (select 1 from public.profiles where id = (select auth.uid()) and status = 'active')
);
