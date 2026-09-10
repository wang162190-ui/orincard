do $$ begin
  if not exists (select 1 from pg_type where typnamespace='public'::regnamespace and typname='affiliate_state') then create type public.affiliate_state as enum ('applied','approved','rejected','suspended'); end if;
  if not exists (select 1 from pg_type where typnamespace='public'::regnamespace and typname='tax_status') then create type public.tax_status as enum ('missing','verified'); end if;
  if not exists (select 1 from pg_type where typnamespace='public'::regnamespace and typname='referral_state') then create type public.referral_state as enum ('active','self_rejected','revoked','expired'); end if;
  if not exists (select 1 from pg_type where typnamespace='public'::regnamespace and typname='commission_state') then create type public.commission_state as enum ('pending','eligible','paid','reversed'); end if;
  if not exists (select 1 from pg_type where typnamespace='public'::regnamespace and typname='support_status') then create type public.support_status as enum ('open','closed'); end if;
end $$;
comment on type public.affiliate_state is 'Affiliate申请的受控审核状态';
comment on type public.tax_status is 'Affiliate税务资料核验状态，不包含税号原文';
comment on type public.referral_state is '经用户同意的推荐归因状态';
comment on type public.commission_state is '佣金及负向反冲流水状态';
comment on type public.support_status is '支持工单处理状态';

create table public.affiliate_accounts (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null unique references auth.users(id) on delete restrict,
  application jsonb not null check (jsonb_typeof(application)='object' and not (application ?| array['tax_id','bank_account','password','api_key'])),
  state public.affiliate_state not null default 'applied', referral_code text unique,
  policy_version text, tax_status public.tax_status not null default 'missing', payout_reference text,
  review_actor text, review_reason text, review_environment text,
  reviewed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint affiliate_approval_fields check ((state='approved' and referral_code is not null and policy_version is not null and reviewed_at is not null) or state<>'approved')
);
comment on table public.affiliate_accounts is 'Affiliate申请、审核和唯一推荐码；公开读取不含收款资料';
comment on column public.affiliate_accounts.id is 'Affiliate账户唯一标识'; comment on column public.affiliate_accounts.owner_id is '申请账户所有者';
comment on column public.affiliate_accounts.application is '用户主动提交且排除税号、账户和密钥的申请资料'; comment on column public.affiliate_accounts.state is '受控审核状态';
comment on column public.affiliate_accounts.referral_code is '批准时生成的唯一推荐码'; comment on column public.affiliate_accounts.policy_version is '批准采用的Affiliate政策版本';
comment on column public.affiliate_accounts.tax_status is '税务资料核验状态'; comment on column public.affiliate_accounts.payout_reference is '仅服务端可读的受控收款记录编号';
comment on column public.affiliate_accounts.review_actor is '执行审批的受控操作员标识'; comment on column public.affiliate_accounts.review_reason is '审批理由'; comment on column public.affiliate_accounts.review_environment is '审批发生的隔离环境';
comment on column public.affiliate_accounts.reviewed_at is '最近审核时间'; comment on column public.affiliate_accounts.created_at is '申请创建时间'; comment on column public.affiliate_accounts.updated_at is '申请最近更新时间';

create table public.referrals (
 id uuid primary key default gen_random_uuid(), affiliate_account_id uuid not null references public.affiliate_accounts(id) on delete restrict,
 affiliate_owner_id uuid not null references auth.users(id) on delete restrict, referred_owner_id uuid references auth.users(id) on delete restrict,
 code text not null, policy_version text not null, consent_at timestamptz not null, attributed_at timestamptz not null default now(), expires_at timestamptz not null,
 visitor_hash text not null check (visitor_hash ~ '^[0-9a-f]{64}$'),
 state public.referral_state not null, constraint referral_window check (expires_at > consent_at),
 constraint referral_self_state check ((affiliate_owner_id=referred_owner_id and state='self_rejected') or affiliate_owner_id is distinct from referred_owner_id)
);
comment on table public.referrals is '用户明确同意后形成的推荐归因，不向推荐人公开购买者身份';
comment on column public.referrals.id is '推荐归因唯一标识'; comment on column public.referrals.affiliate_account_id is '归因时已批准的Affiliate账户';
comment on column public.referrals.affiliate_owner_id is '推荐人账户，仅用于服务端归属'; comment on column public.referrals.referred_owner_id is '被推荐账户，仅用于服务端归因';
comment on column public.referrals.code is '归因时推荐码快照'; comment on column public.referrals.policy_version is '归因采用的政策版本';
comment on column public.referrals.visitor_hash is '不可逆访客标识哈希，不保存原始浏览器标识';
comment on column public.referrals.consent_at is '被推荐用户明确同意时间'; comment on column public.referrals.attributed_at is '服务端记录归因时间';
comment on column public.referrals.expires_at is '归因窗口截止时间'; comment on column public.referrals.state is '有效、自荐拒绝、撤销或过期状态';
create unique index referrals_one_active_owner on public.referrals(referred_owner_id) where state='active' and referred_owner_id is not null;

create table public.commissions (
 id uuid primary key default gen_random_uuid(), referral_id uuid not null references public.referrals(id) on delete restrict,
 provider_invoice_id text not null, policy_version text not null, amount_minor integer not null check (amount_minor<>0), currency text not null check (currency ~ '^[A-Z]{3}$'),
 state public.commission_state not null, reversal_of uuid unique references public.commissions(id) on delete restrict,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 constraint commission_reversal_shape check ((reversal_of is null and amount_minor>0 and state<>'reversed') or (reversal_of is not null and amount_minor<0 and state='reversed'))
);
comment on table public.commissions is '不删除历史的佣金和退款负向反冲流水';
comment on column public.commissions.id is '佣金流水唯一标识'; comment on column public.commissions.referral_id is '佣金关联的有效推荐';
comment on column public.commissions.provider_invoice_id is '供应商发票唯一业务键'; comment on column public.commissions.policy_version is '佣金计算政策版本';
comment on column public.commissions.amount_minor is '最小货币单位金额，反冲为负数'; comment on column public.commissions.currency is '三位大写货币代码';
comment on column public.commissions.state is '待定、可结算、已支付或反冲状态'; comment on column public.commissions.reversal_of is '负向流水对应的原佣金';
comment on column public.commissions.created_at is '流水创建时间'; comment on column public.commissions.updated_at is '流水最近更新时间';
create unique index commissions_invoice_original on public.commissions(provider_invoice_id) where reversal_of is null;

create table public.support_tickets (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete restrict,
 category text not null check (category in ('account','billing','export','copyright')), message text not null check (length(btrim(message)) between 1 and 5000),
 diagnostic_refs jsonb not null default '{}'::jsonb check (jsonb_typeof(diagnostic_refs)='object' and not (diagnostic_refs ?| array['content','document','payment','secret','api_key'])),
 status public.support_status not null default 'open', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
comment on table public.support_tickets is '用户主动提交的支持工单，仅附用户选择的诊断标识';
comment on column public.support_tickets.id is '工单唯一标识'; comment on column public.support_tickets.owner_id is '提交工单的账户';
comment on column public.support_tickets.category is '账号、账单、导出或版权分类'; comment on column public.support_tickets.message is '用户主动提交的工单正文';
comment on column public.support_tickets.diagnostic_refs is '用户选择且不含项目正文或支付资料的诊断标识'; comment on column public.support_tickets.status is '受控支持人员维护的处理状态';
comment on column public.support_tickets.created_at is '工单创建时间'; comment on column public.support_tickets.updated_at is '工单最近更新时间';

create or replace function public.server_apply_affiliate(p_owner_id uuid,p_application jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid; begin
 if jsonb_typeof(p_application)<>'object' or p_application ?| array['tax_id','bank_account','password','api_key'] then raise exception using errcode='22023',message='invalid affiliate application'; end if;
 insert into public.affiliate_accounts(owner_id,application) values(p_owner_id,p_application) on conflict(owner_id) do update set application=excluded.application,updated_at=now() where affiliate_accounts.state in ('applied','rejected') returning id into result;
 return result;
end $$;
comment on function public.server_apply_affiliate(uuid,jsonb) is '以owner绑定方式提交或更新Affiliate申请且不能自批';

create or replace function public.server_review_affiliate(p_owner_id uuid,p_approved boolean,p_policy_version text) returns text language plpgsql security definer set search_path='' as $$
declare code text; begin
 if p_approved and length(btrim(p_policy_version))=0 then raise exception using errcode='22023',message='policy version required'; end if;
 code := case when p_approved then upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)) else null end;
 update public.affiliate_accounts set state=case when p_approved then 'approved'::public.affiliate_state else 'rejected'::public.affiliate_state end,referral_code=code,policy_version=case when p_approved then p_policy_version else policy_version end,reviewed_at=now(),updated_at=now() where owner_id=p_owner_id returning referral_code into code;
 if not found then raise exception using errcode='P0002',message='affiliate application not found'; end if; return code;
end $$;
comment on function public.server_review_affiliate(uuid,boolean,text) is '受控审批Affiliate并在批准时生成唯一推荐码';

create or replace function public.server_review_affiliate(p_account_id uuid,p_approved boolean,p_policy_version text,p_reason text,p_actor text,p_environment text) returns text language plpgsql security definer set search_path='' as $$
declare code text; begin
 if length(btrim(p_actor))=0 or p_environment not in ('development','preview','production') then raise exception using errcode='22023',message='review audit context required'; end if;
 if p_approved and length(btrim(p_policy_version))=0 then raise exception using errcode='22023',message='policy version required'; end if;
 code := case when p_approved then upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)) else null end;
 update public.affiliate_accounts set state=case when p_approved then 'approved'::public.affiliate_state else 'rejected'::public.affiliate_state end,referral_code=code,policy_version=case when p_approved then p_policy_version else policy_version end,review_actor=p_actor,review_reason=p_reason,review_environment=p_environment,reviewed_at=now(),updated_at=now() where id=p_account_id returning referral_code into code;
 if not found then raise exception using errcode='P0002',message='affiliate application not found'; end if; return code;
end $$;
comment on function public.server_review_affiliate(uuid,boolean,text,text,text,text) is '以申请ID受控审批Affiliate并持久化操作员、理由和环境审计';

create or replace function public.server_attribute_referral(p_referred_owner_id uuid,p_code text,p_consent_at timestamptz,p_expires_at timestamptz) returns uuid language plpgsql security definer set search_path='' as $$
declare account public.affiliate_accounts; result uuid; target_state public.referral_state; begin
 select * into account from public.affiliate_accounts where referral_code=p_code and state='approved';
 if account.id is null or p_consent_at is null or p_expires_at<=p_consent_at or p_consent_at>now()+interval '5 minutes' then raise exception using errcode='22023',message='invalid referral consent or window'; end if;
 target_state := case when account.owner_id=p_referred_owner_id then 'self_rejected' else 'active' end;
 insert into public.referrals(affiliate_account_id,affiliate_owner_id,referred_owner_id,code,policy_version,consent_at,expires_at,visitor_hash,state) values(account.id,account.owner_id,p_referred_owner_id,p_code,account.policy_version,p_consent_at,p_expires_at,encode(extensions.digest(convert_to(coalesce(p_referred_owner_id::text,gen_random_uuid()::text),'UTF8'),'sha256'),'hex'),target_state) returning id into result;
 return result;
end $$;
comment on function public.server_attribute_referral(uuid,text,timestamptz,timestamptz) is '仅对已批准推荐码和明确同意窗口建立唯一归因并记录自荐拒绝';

create or replace function public.server_record_commission(p_referral_id uuid,p_invoice_id text,p_policy_version text,p_amount_minor integer,p_currency text) returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid; begin
 if not exists(select 1 from public.referrals where id=p_referral_id and state='active' and expires_at>now()) then raise exception using errcode='22023',message='active referral required'; end if;
 insert into public.commissions(referral_id,provider_invoice_id,policy_version,amount_minor,currency,state) values(p_referral_id,p_invoice_id,p_policy_version,p_amount_minor,upper(p_currency),'pending') on conflict(provider_invoice_id) where reversal_of is null do update set provider_invoice_id=excluded.provider_invoice_id returning id into result; return result;
end $$;
comment on function public.server_record_commission(uuid,text,text,integer,text) is '按供应商发票幂等记录有效归因佣金';

create or replace function public.server_reverse_commission(p_original_id uuid,p_policy_version text) returns uuid language plpgsql security definer set search_path='' as $$
declare original public.commissions; result uuid; begin
 select * into original from public.commissions where id=p_original_id and reversal_of is null;
 if original.id is null then raise exception using errcode='P0002',message='commission not found'; end if;
 insert into public.commissions(referral_id,provider_invoice_id,policy_version,amount_minor,currency,state,reversal_of) values(original.referral_id,original.provider_invoice_id,p_policy_version,-original.amount_minor,original.currency,'reversed',original.id) on conflict(reversal_of) do update set reversal_of=excluded.reversal_of returning id into result; return result;
end $$;
comment on function public.server_reverse_commission(uuid,text) is '退款时幂等追加负向反冲且保留原佣金证据';

alter table public.affiliate_accounts enable row level security; alter table public.referrals enable row level security; alter table public.commissions enable row level security; alter table public.support_tickets enable row level security;
revoke all on public.affiliate_accounts,public.referrals,public.commissions,public.support_tickets from public,anon,authenticated,service_role;
grant select(id,state,referral_code,policy_version,tax_status,reviewed_at,created_at,updated_at) on public.affiliate_accounts to authenticated;
grant select(id,category,message,diagnostic_refs,status,created_at,updated_at),insert(owner_id,category,message,diagnostic_refs) on public.support_tickets to authenticated;
grant select,insert,update,delete on public.affiliate_accounts,public.referrals,public.commissions,public.support_tickets to service_role;
create policy affiliate_read_own on public.affiliate_accounts for select to authenticated using(owner_id=(select auth.uid()));
create policy support_read_own on public.support_tickets for select to authenticated using(owner_id=(select auth.uid()));
create policy support_insert_own on public.support_tickets for insert to authenticated with check(owner_id=(select auth.uid()));
revoke execute on function public.server_apply_affiliate(uuid,jsonb),public.server_review_affiliate(uuid,boolean,text),public.server_attribute_referral(uuid,text,timestamptz,timestamptz),public.server_record_commission(uuid,text,text,integer,text),public.server_reverse_commission(uuid,text) from public,anon,authenticated;
revoke execute on function public.server_review_affiliate(uuid,boolean,text,text,text,text) from public,anon,authenticated;
grant execute on function public.server_apply_affiliate(uuid,jsonb),public.server_review_affiliate(uuid,boolean,text),public.server_attribute_referral(uuid,text,timestamptz,timestamptz),public.server_record_commission(uuid,text,text,integer,text),public.server_reverse_commission(uuid,text) to service_role;
grant execute on function public.server_review_affiliate(uuid,boolean,text,text,text,text) to service_role;
