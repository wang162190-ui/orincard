create or replace function public.server_attribute_referral(p_referred_owner_id uuid,p_code text,p_consent_at timestamptz,p_expires_at timestamptz) returns uuid language plpgsql security definer set search_path='' as $$
declare account public.affiliate_accounts; result uuid; target_state public.referral_state; begin
 select * into account from public.affiliate_accounts where referral_code=p_code and state='approved';
 if account.id is null or p_consent_at is null or p_expires_at<=p_consent_at or p_consent_at>now()+interval '5 minutes' then raise exception using errcode='22023',message='invalid referral consent or window'; end if;
 target_state := case when account.owner_id=p_referred_owner_id then 'self_rejected' else 'active' end;
 insert into public.referrals(affiliate_account_id,affiliate_owner_id,referred_owner_id,code,policy_version,consent_at,expires_at,visitor_hash,state) values(account.id,account.owner_id,p_referred_owner_id,p_code,account.policy_version,p_consent_at,p_expires_at,encode(extensions.digest(convert_to(coalesce(p_referred_owner_id::text,gen_random_uuid()::text),'UTF8'),'sha256'),'hex'),target_state) returning id into result;
 return result;
end $$;

comment on function public.server_attribute_referral(uuid,text,timestamptz,timestamptz) is '仅对已批准推荐码和明确同意窗口建立唯一归因并记录自荐拒绝';
revoke execute on function public.server_attribute_referral(uuid,text,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.server_attribute_referral(uuid,text,timestamptz,timestamptz) to service_role;
