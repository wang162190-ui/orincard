begin;
set local search_path = extensions, public, pg_catalog;
select plan(27);

select has_table('public', 'billing_customers', 'billing customers table exists');
select has_table('public', 'subscriptions', 'subscriptions table exists');
select has_table('private', 'billing_events', 'billing events table exists');
select has_table('private', 'billing_audit_log', 'billing audit table exists');
select is((select count(*)::integer from pg_attribute where attrelid = 'public.subscriptions'::regclass and attnum > 0 and not attisdropped and col_description(attrelid, attnum) is not null), 12, 'every subscription field is commented');
select is((select count(*)::integer from pg_attribute where attrelid = 'private.billing_events'::regclass and attnum > 0 and not attisdropped and col_description(attrelid, attnum) is not null), 8, 'every billing event field is commented');
select is((select count(*)::integer from pg_attribute where attrelid = 'private.billing_audit_log'::regclass and attnum > 0 and not attisdropped and col_description(attrelid, attnum) is not null), 7, 'every billing audit field is commented');
select ok(not has_table_privilege('authenticated', 'private.billing_events', 'select'), 'clients cannot read billing events');
select ok(not has_table_privilege('authenticated', 'private.billing_audit_log', 'select'), 'clients cannot read billing audit');
select ok(not has_function_privilege('authenticated', 'public.server_apply_billing_event(text,uuid,text,text,public.billing_plan_key,text,public.subscription_status,timestamptz,timestamptz,boolean,timestamptz,text,text,jsonb)', 'execute'), 'clients cannot apply billing events');
select ok(not has_column_privilege('authenticated', 'public.subscriptions', 'provider_customer_id', 'select'), 'clients cannot read provider customer IDs');
select ok(not has_column_privilege('authenticated', 'public.subscriptions', 'provider_subscription_id', 'select'), 'clients cannot read provider subscription IDs');
select ok(not has_table_privilege('authenticated', 'public.billing_customers', 'select'), 'clients cannot read billing customer mappings');

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '91111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'billing-owner@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '92222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'billing-other@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

set local role service_role;
select ok(public.server_register_billing_event('evt_invoice_1', 'invoice.paid', 'in_1'), 'first event is registered');
select ok(not public.server_register_billing_event('evt_invoice_1', 'invoice.paid', 'in_1'), 'duplicate event is acknowledged without a duplicate row');
select results_eq($$select attempt from public.server_claim_billing_event('evt_invoice_1')$$, array[1], 'registered event is claimed once');
select ok(public.server_apply_billing_event(
  'evt_invoice_1', '91111111-1111-4111-8111-111111111111', 'cus_1', 'sub_1', 'pro', 'policy-1', 'active',
  '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', false, '2026-09-10T00:00:00Z', 'in_1', 'invoice_paid', '{"currency":"usd"}'::jsonb
), 'claimed event applies subscription and audit atomically');
select ok(not public.server_apply_billing_event(
  'evt_invoice_1', '91111111-1111-4111-8111-111111111111', 'cus_1', 'sub_1', 'pro', 'policy-1', 'active',
  '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', false, '2026-09-10T00:00:00Z', 'in_1', 'invoice_paid', '{}'::jsonb
), 'duplicate apply does not grant twice');

select public.server_register_billing_event('evt_invoice_2', 'invoice.paid', 'in_2');
select * from public.server_claim_billing_event('evt_invoice_2');
select ok(public.server_apply_billing_event(
  'evt_invoice_2', '91111111-1111-4111-8111-111111111111', 'cus_1', 'sub_1', 'creator', 'policy-2', 'active',
  '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', false, '2026-09-10T00:00:00Z', 'in_2', 'invoice_paid', '{"currency":"usd"}'::jsonb
), 'a different invoice event at the same timestamp remains distinct');
reset role;

select results_eq($$select count(*)::bigint from private.billing_events$$, array[2::bigint], 'event ID uniqueness stores two distinct events');
select results_eq($$select count(*)::bigint from private.billing_audit_log where provider_invoice_id in ('in_1', 'in_2')$$, array[2::bigint], 'different invoice IDs are never merged by timestamp');
select results_eq($$select plan_key::text, policy_version from public.subscriptions where owner_id = '91111111-1111-4111-8111-111111111111'$$, $$values ('creator'::text, 'policy-2'::text)$$, 'latest equal-time provider snapshot is deterministic');

set local role authenticated;
set local "request.jwt.claim.sub" = '91111111-1111-4111-8111-111111111111';
select results_eq($$select plan_key::text from public.subscriptions$$, array['creator'::text], 'owner reads their subscription summary');
reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '92222222-2222-4222-8222-222222222222';
select is_empty($$select id from public.subscriptions$$, 'another account cannot read the subscription');
reset role;

select throws_ok($$update private.billing_audit_log set action = 'tampered'$$, '55000', 'billing audit is append only', 'billing audit rejects updates');
select throws_ok($$delete from private.billing_audit_log$$, '55000', 'billing audit is append only', 'billing audit rejects deletion');
select results_eq($$select count(*)::bigint from private.billing_audit_log where provider_event_id = 'evt_invoice_1'$$, array[1::bigint], 'duplicate application leaves one audit record');

select * from finish(true);
rollback;
