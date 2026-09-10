begin;
set local search_path=extensions,public,pg_catalog;
select plan(32);
select has_table('public','affiliate_accounts','affiliate accounts table exists');
select has_table('public','referrals','referrals table exists');
select has_table('public','commissions','commissions table exists');
select has_table('public','support_tickets','support tickets table exists');
select is((select count(*)::integer from pg_attribute where attrelid='public.affiliate_accounts'::regclass and attnum>0 and not attisdropped and col_description(attrelid,attnum) is not null),11,'all affiliate fields are commented');
select is((select count(*)::integer from pg_attribute where attrelid='public.referrals'::regclass and attnum>0 and not attisdropped and col_description(attrelid,attnum) is not null),10,'all referral fields are commented');
select is((select count(*)::integer from pg_attribute where attrelid='public.commissions'::regclass and attnum>0 and not attisdropped and col_description(attrelid,attnum) is not null),10,'all commission fields are commented');
select is((select count(*)::integer from pg_attribute where attrelid='public.support_tickets'::regclass and attnum>0 and not attisdropped and col_description(attrelid,attnum) is not null),8,'all support fields are commented');
select ok(not has_column_privilege('authenticated','public.affiliate_accounts','payout_reference','select'),'payout reference is hidden');
select ok(not has_column_privilege('authenticated','public.affiliate_accounts','application','select'),'application details are hidden');
select ok(not has_table_privilege('authenticated','public.referrals','select'),'affiliate cannot read buyer referrals');
select ok(not has_table_privilege('authenticated','public.commissions','select'),'affiliate cannot read raw commission rows');
select ok(not has_function_privilege('authenticated','public.server_review_affiliate(uuid,boolean,text)','execute'),'client cannot self approve');

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','a1111111-1111-4111-8111-111111111111','authenticated','authenticated','affiliate@example.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','a2222222-2222-4222-8222-222222222222','authenticated','authenticated','buyer@example.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','a3333333-3333-4333-8333-333333333333','authenticated','authenticated','other@example.invalid','',now(),'{}','{}',now(),now());

set local role service_role;
select isnt(public.server_apply_affiliate('a1111111-1111-4111-8111-111111111111','{"channel":"newsletter"}'),null,'application is recorded');
select is((select state::text from public.affiliate_accounts where owner_id='a1111111-1111-4111-8111-111111111111'),'applied','application cannot approve itself');
select matches(public.server_review_affiliate('a1111111-1111-4111-8111-111111111111',true,'affiliate-2026-09'),'^[A-F0-9]{12}$','approval creates a code');
select is((select count(distinct referral_code)::integer from public.affiliate_accounts where referral_code is not null),1,'approved referral code is unique');
select isnt(public.server_attribute_referral('a1111111-1111-4111-8111-111111111111',(select referral_code from public.affiliate_accounts where owner_id='a1111111-1111-4111-8111-111111111111'),now(),now()+interval '30 days'),null,'self referral is retained as rejected evidence');
select is((select state::text from public.referrals where referred_owner_id='a1111111-1111-4111-8111-111111111111'),'self_rejected','self referral never becomes active');
select isnt(public.server_attribute_referral('a2222222-2222-4222-8222-222222222222',(select referral_code from public.affiliate_accounts where owner_id='a1111111-1111-4111-8111-111111111111'),now(),now()+interval '30 days'),null,'explicit consent creates an active referral');
select throws_ok(format('select public.server_attribute_referral(%L,%L,now(),now()+interval ''30 days'')','a2222222-2222-4222-8222-222222222222',(select referral_code from public.affiliate_accounts limit 1)),'23505',null,'one buyer cannot have two active attributions');
select throws_ok(format('select public.server_attribute_referral(%L,%L,now(),now()-interval ''1 day'')','a3333333-3333-4333-8333-333333333333',(select referral_code from public.affiliate_accounts limit 1)),'22023','invalid referral consent or window','invalid attribution window is rejected');
select isnt(public.server_record_commission((select id from public.referrals where state='active'),'in_growth_1','affiliate-2026-09',500,'usd'),null,'active attribution earns a commission');
select is(public.server_record_commission((select id from public.referrals where state='active'),'in_growth_1','affiliate-2026-09',500,'usd'),(select id from public.commissions where provider_invoice_id='in_growth_1' and reversal_of is null),'invoice commission is idempotent');
select isnt(public.server_reverse_commission((select id from public.commissions where provider_invoice_id='in_growth_1' and reversal_of is null),'affiliate-2026-09'),null,'refund appends one negative reversal');
select is((select sum(amount_minor)::integer from public.commissions where provider_invoice_id='in_growth_1'),0,'refund nets original commission to zero');
select is((select count(*)::integer from public.commissions where provider_invoice_id='in_growth_1'),2,'reversal preserves the original evidence');
reset role;

set local role authenticated;
set local "request.jwt.claim.sub"='a1111111-1111-4111-8111-111111111111';
select is((select count(*)::integer from public.affiliate_accounts),1,'owner reads their redacted affiliate row');
insert into public.support_tickets(owner_id,category,message,diagnostic_refs) values('a1111111-1111-4111-8111-111111111111','billing','Please check invoice','{"job_id":"job-1"}');
select is((select count(*)::integer from public.support_tickets),1,'owner reads their support ticket');
set local "request.jwt.claim.sub"='a3333333-3333-4333-8333-333333333333';
select is_empty('select id from public.affiliate_accounts','another owner cannot read the application');
select is_empty('select id from public.support_tickets','another owner cannot read the ticket');
select throws_ok($$insert into public.support_tickets(owner_id,category,message) values('a1111111-1111-4111-8111-111111111111','billing','forged')$$,'42501',null,'owner cannot forge another support ticket');
reset role;
select * from finish(true);
rollback;
