alter table public.affiliate_accounts
  add column if not exists review_actor text,
  add column if not exists review_reason text,
  add column if not exists review_environment text;

comment on column public.affiliate_accounts.review_actor is '执行审批的受控操作员标识';
comment on column public.affiliate_accounts.review_reason is '审批理由';
comment on column public.affiliate_accounts.review_environment is '审批发生的隔离环境';

create or replace function public.server_review_affiliate(p_account_id uuid,p_approved boolean,p_policy_version text,p_reason text,p_actor text,p_environment text) returns text language plpgsql security definer set search_path='' as $$
declare code text; begin
 if length(btrim(p_actor))=0 or p_environment not in ('development','preview','production') then raise exception using errcode='22023',message='review audit context required'; end if;
 if p_approved and length(btrim(p_policy_version))=0 then raise exception using errcode='22023',message='policy version required'; end if;
 code := case when p_approved then upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)) else null end;
 update public.affiliate_accounts set state=case when p_approved then 'approved'::public.affiliate_state else 'rejected'::public.affiliate_state end,referral_code=code,policy_version=case when p_approved then p_policy_version else policy_version end,review_actor=p_actor,review_reason=p_reason,review_environment=p_environment,reviewed_at=now(),updated_at=now() where id=p_account_id returning referral_code into code;
 if not found then raise exception using errcode='P0002',message='affiliate application not found'; end if; return code;
end $$;

comment on function public.server_review_affiliate(uuid,boolean,text,text,text,text) is '以申请ID受控审批Affiliate并持久化操作员、理由和环境审计';
revoke execute on function public.server_review_affiliate(uuid,boolean,text,text,text,text) from public,anon,authenticated;
grant execute on function public.server_review_affiliate(uuid,boolean,text,text,text,text) to service_role;
