begin;
set local search_path = extensions, public, pg_catalog;
select plan(45);

select has_table('public', 'jobs', 'jobs table exists');
select has_table('public', 'usage_accounts', 'usage_accounts table exists');
select has_table('public', 'usage_ledger', 'usage_ledger table exists');
select has_table('private', 'cost_budgets', 'cost_budgets table exists');
select has_table('private', 'cost_reservations', 'cost_reservations table exists');
select has_table('private', 'cost_attempts', 'cost_attempts table exists');
select has_table('private', 'operation_receipts', 'operation_receipts table exists');
select has_table('private', 'request_guards', 'request_guards table exists');
select is((select count(*)::integer from pg_attribute where attrelid = 'public.jobs'::regclass and attnum > 0 and not attisdropped and col_description(attrelid, attnum) is not null), 21, 'every jobs column is commented');
select ok(not has_table_privilege('authenticated', 'private.cost_budgets', 'select'), 'clients cannot read provider budgets');

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '51111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'job-owner@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '52222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'job-other@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

set local role service_role;
select private.create_project(
  '51111111-1111-1111-1111-111111111111', 'Job project', 'linkedin',
  '{"schemaVersion":1,"title":"Job project","platform":"linkedin"}'::jsonb
);
reset role;
insert into public.usage_accounts (owner_id, period_start, period_end, resource, granted)
values ('51111111-1111-1111-1111-111111111111', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 'generation', 1);
insert into private.cost_budgets (period, environment, limit_micro_usd)
values (to_char(now() at time zone 'utc', 'YYYY-MM'), 'development', 1000);

set local role service_role;
select lives_ok(
  format(
    $$select private.submit_job('51111111-1111-1111-1111-111111111111', %L, 'generation', '{"sourceId":"safe-id"}'::jsonb, 'submit-1', %L, 'generation', 1, date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 'development', to_char(now() at time zone 'utc', 'YYYY-MM'), 100)$$,
    (select id from public.projects where owner_id = '51111111-1111-1111-1111-111111111111'), repeat('a', 32)
  ),
  'a valid job, quota reservation and outbox row commit together'
);
select results_eq($$select count(*)::bigint from public.jobs where owner_id = '51111111-1111-1111-1111-111111111111'$$, array[1::bigint], 'one outbox job is created');
select results_eq($$select reserved from public.usage_accounts where owner_id = '51111111-1111-1111-1111-111111111111'$$, array[1::bigint], 'one user unit is reserved');
select results_eq($$select reserved_micro_usd from private.cost_budgets where environment = 'development'$$, array[100::bigint], 'provider cost is reserved');
select lives_ok(
  format(
    $$select private.submit_job('51111111-1111-1111-1111-111111111111', %L, 'generation', '{"sourceId":"safe-id"}'::jsonb, 'submit-1', %L, 'generation', 1, date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 'development', to_char(now() at time zone 'utc', 'YYYY-MM'), 100)$$,
    (select id from public.projects where owner_id = '51111111-1111-1111-1111-111111111111'), repeat('a', 32)
  ),
  'duplicate submit returns the original job without a second reservation'
);
select results_eq($$select count(*)::bigint from public.jobs where owner_id = '51111111-1111-1111-1111-111111111111'$$, array[1::bigint], 'duplicate submit creates no second job');
select results_eq($$select count(*)::bigint from public.usage_ledger where kind = 'reserve'$$, array[1::bigint], 'duplicate submit creates no second reserve ledger event');
select results_eq($$select count(*)::bigint from private.cost_reservations$$, array[1::bigint], 'duplicate submit creates no second cost reservation');
select throws_ok(
  format(
    $$select private.submit_job('51111111-1111-1111-1111-111111111111', %L, 'generation', '{"sourceId":"different"}'::jsonb, 'submit-1', %L, 'generation', 1, date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 'development', to_char(now() at time zone 'utc', 'YYYY-MM'), 100)$$,
    (select id from public.projects where owner_id = '51111111-1111-1111-1111-111111111111'), repeat('b', 32)
  ),
  '23505', 'idempotency key request hash conflict', 'same key with different input is rejected'
);
select throws_ok(
  format(
    $$select private.submit_job('51111111-1111-1111-1111-111111111111', %L, 'generation', '{"sourceId":"second"}'::jsonb, 'submit-2', %L, 'generation', 1, date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 'development', to_char(now() at time zone 'utc', 'YYYY-MM'), 100)$$,
    (select id from public.projects where owner_id = '51111111-1111-1111-1111-111111111111'), repeat('c', 32)
  ),
  '22003', 'insufficient usage balance', 'concurrent reservations cannot overdraw an account'
);
select lives_ok($$select private.register_cost_attempt((select id from public.jobs where idempotency_key = 'submit-1'), 'job:submit-1:write:1')$$, 'a provider attempt is recorded before sending');
select lives_ok($$select private.register_cost_attempt((select id from public.jobs where idempotency_key = 'submit-1'), 'job:submit-1:write:1')$$, 'provider attempt replay is idempotent');
select results_eq($$select count(*)::bigint from private.cost_attempts$$, array[1::bigint], 'attempt replay creates one row');
select lives_ok($$select private.settle_cost_attempt((select id from public.jobs where idempotency_key = 'submit-1'), 'job:submit-1:write:1', 'provider-operation-1', '{"inputTokens":10,"outputTokens":20}'::jsonb, 150)$$, 'a provider attempt records its actual cost');
select lives_ok($$select private.settle_cost_attempt((select id from public.jobs where idempotency_key = 'submit-1'), 'job:submit-1:write:1', 'provider-operation-1', '{"inputTokens":10,"outputTokens":20}'::jsonb, 150)$$, 'the same attempt settlement replays idempotently');
select results_eq($$select state, actual_micro_usd from private.cost_attempts where attempt_key = 'job:submit-1:write:1'$$, $$values ('settled'::private.cost_attempt_state, 150::bigint)$$, 'attempt audit stores a settled actual amount');
select lives_ok($$select private.request_job_cancellation('51111111-1111-1111-1111-111111111111', (select id from public.jobs where idempotency_key = 'submit-1'))$$, 'cancel request is persisted');
select ok((select cancel_requested_at is not null from public.jobs where idempotency_key = 'submit-1'), 'cancel_requested_at is durable');
select lives_ok($$select private.finalize_job('51111111-1111-1111-1111-111111111111', (select id from public.jobs where idempotency_key = 'submit-1'), null, 'succeeded', '{"candidate":"safe-id"}'::jsonb, null, 0, 150, 'job:submit-1:terminal')$$, 'cancel wins over a later success callback');
select results_eq($$select reserved, consumed from public.usage_accounts where owner_id = '51111111-1111-1111-1111-111111111111'$$, $$values (0::bigint, 0::bigint)$$, 'canceled delivery releases product quota');
select results_eq($$select reserved_micro_usd, spent_micro_usd from private.cost_budgets where environment = 'development'$$, $$values (0::bigint, 150::bigint)$$, 'actual provider cost above the estimate is still recorded after cancellation');
select results_eq($$select state from public.jobs where idempotency_key = 'submit-1'$$, array['canceled'::public.job_state], 'canceled terminal state is stored');
select lives_ok($$select private.finalize_job('51111111-1111-1111-1111-111111111111', (select id from public.jobs where idempotency_key = 'submit-1'), null, 'succeeded', '{"candidate":"safe-id"}'::jsonb, null, 0, 150, 'job:submit-1:terminal')$$, 'duplicate finalize does not consume twice');
select results_eq($$select count(*)::bigint from public.usage_ledger where job_id = (select id from public.jobs where idempotency_key = 'submit-1') and kind in ('settle', 'release')$$, array[1::bigint], 'duplicate finalize creates one terminal ledger event');

select lives_ok(
  format(
    $$select private.save_project('51111111-1111-1111-1111-111111111111', %L, 1, 'Saved once', 'instagram', '{"schemaVersion":1,"title":"Saved once","platform":"instagram"}'::jsonb, 'manual', 'save-1', %L)$$,
    (select id from public.projects where owner_id = '51111111-1111-1111-1111-111111111111'), repeat('d', 32)
  ),
  'a new save commits revision, snapshot and receipt'
);
select results_eq($$select revision from public.projects where owner_id = '51111111-1111-1111-1111-111111111111'$$, array[2::bigint], 'first receipt save advances revision');
select lives_ok(
  format(
    $$select private.save_project('51111111-1111-1111-1111-111111111111', %L, 2, 'Saved twice', 'tiktok', '{"schemaVersion":1,"title":"Saved twice","platform":"tiktok"}'::jsonb, 'manual', 'save-2', %L)$$,
    (select id from public.projects where owner_id = '51111111-1111-1111-1111-111111111111'), repeat('e', 32)
  ),
  'a different save can advance the project again'
);
select results_eq(
  format(
    $$select (private.save_project('51111111-1111-1111-1111-111111111111', %L, 1, 'Saved once', 'instagram', '{"schemaVersion":1,"title":"Saved once","platform":"instagram"}'::jsonb, 'manual', 'save-1', %L)->>'revision')::bigint$$,
    (select id from public.projects where owner_id = '51111111-1111-1111-1111-111111111111'), repeat('d', 32)
  ),
  array[2::bigint],
  'same save receipt replays after revision advanced'
);
select results_eq($$select revision from public.projects where owner_id = '51111111-1111-1111-1111-111111111111'$$, array[3::bigint], 'receipt replay does not overwrite the newer revision');
select results_eq($$select count(*)::bigint from private.operation_receipts where owner_id = '51111111-1111-1111-1111-111111111111'$$, array[2::bigint], 'each distinct save has one receipt');
select throws_ok(
  format(
    $$select private.save_project('51111111-1111-1111-1111-111111111111', %L, 1, 'Changed replay', 'instagram', '{"schemaVersion":1,"title":"Changed replay","platform":"instagram"}'::jsonb, 'manual', 'save-1', %L)$$,
    (select id from public.projects where owner_id = '51111111-1111-1111-1111-111111111111'), repeat('f', 32)
  ),
  '23505', 'idempotency key request hash conflict', 'a save key cannot be reused with another request'
);
select throws_ok($$update public.usage_ledger set units = 2 where kind = 'reserve'$$, '55000', 'usage ledger is append-only', 'usage ledger cannot be rewritten');
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '51111111-1111-1111-1111-111111111111';
select results_eq($$select count(*)::bigint from public.jobs$$, array[1::bigint], 'an owner reads only their job status');
reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '52222222-2222-2222-2222-222222222222';
select is_empty($$select id from public.jobs$$, 'another account cannot guess a job id');
reset role;
update public.profiles set status = 'deleting' where id = '51111111-1111-1111-1111-111111111111';
set local role authenticated;
set local "request.jwt.claim.sub" = '51111111-1111-1111-1111-111111111111';
select is_empty($$select id from public.jobs$$, 'a deleting account cannot read jobs');
reset role;

select * from finish(true);
rollback;
