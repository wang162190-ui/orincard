begin;
set local search_path = extensions, public, pg_catalog;
select plan(51);

select has_table('public', 'exports', 'exports table exists');
select ok(obj_description('public.exports'::regclass, 'pg_class') is not null, 'exports table is commented');
select is(
  (
    select count(*)::integer
    from pg_attribute
    where attrelid = 'public.exports'::regclass
      and attnum > 0
      and not attisdropped
      and col_description(attrelid, attnum) is not null
  ),
  13,
  'every exports column is commented'
);
select ok((select relrowsecurity from pg_class where oid = 'public.exports'::regclass), 'exports RLS is enabled');
select ok(has_table_privilege('authenticated', 'public.exports', 'select'), 'authenticated may read authorized export metadata');
select ok(not has_table_privilege('authenticated', 'public.exports', 'insert'), 'authenticated cannot forge export metadata');
select ok(not has_table_privilege('anon', 'public.exports', 'select'), 'anonymous receives no export metadata access');
select results_eq(
  $$select public from storage.buckets where id = 'exports'$$,
  array[false],
  'the exports bucket exists and is private'
);
select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'storage_download_owned_exports' and 'authenticated' = any(roles)$$,
  array[1::bigint],
  'export download requires current owner authorization'
);

select has_function('public', 'server_create_text_source', array['uuid', 'public.source_kind', 'jsonb', 'jsonb', 'timestamp with time zone', 'text', 'text'], 'atomic text source RPC exists');
select has_function('public', 'server_begin_guest_generation', array['text', 'timestamp with time zone', 'text', 'text', 'integer', 'text', 'bigint', 'text', 'timestamp with time zone'], 'guest request guard RPC exists');
select has_function('public', 'server_finish_guest_generation', array['uuid', 'text'], 'guest request settlement RPC exists');
select has_function('public', 'server_claim_generation_job', array['uuid'], 'generation claim RPC exists');
select has_function('public', 'server_update_generation_progress', array['uuid', 'uuid', 'text', 'integer'], 'generation progress RPC exists');
select has_function('public', 'server_finalize_generation_job', array['uuid', 'uuid', 'jsonb', 'text'], 'generation finalization RPC exists');
select has_function('public', 'server_begin_rewrite_proposal', array['uuid', 'uuid', 'text', 'text', 'jsonb', 'text'], 'rewrite proposal begin RPC exists');
select has_function('public', 'server_complete_rewrite_proposal', array['uuid', 'jsonb'], 'rewrite proposal completion RPC exists');
select has_function('public', 'server_apply_rewrite_proposal', array['uuid', 'uuid', 'bigint', 'bigint', 'text', 'uuid', 'text'], 'rewrite proposal apply RPC exists');
select has_function('public', 'server_begin_regeneration_candidate', array['uuid', 'uuid', 'bigint', 'jsonb', 'text', 'text', 'text'], 'regeneration candidate begin RPC exists');
select has_function('public', 'server_complete_regeneration_candidate', array['uuid', 'jsonb'], 'regeneration candidate completion RPC exists');
select has_function('public', 'server_confirm_regeneration_candidate', array['uuid', 'uuid', 'uuid', 'bigint', 'text', 'text', 'text'], 'regeneration confirmation RPC exists');
select has_function('public', 'server_create_exports', array['uuid', 'uuid', 'bigint', 'text[]', 'jsonb', 'text[]', 'text', 'text'], 'export creation RPC exists');
select has_function('public', 'server_finalize_export', array['uuid', 'uuid', 'uuid', 'jsonb', 'jsonb', 'timestamp with time zone'], 'export finalization RPC exists');

select is(
  (
    select count(*)::integer
    from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = any(array[
        'server_create_text_source', 'server_begin_guest_generation', 'server_finish_guest_generation',
        'server_claim_generation_job', 'server_update_generation_progress', 'server_finalize_generation_job',
        'server_begin_rewrite_proposal', 'server_complete_rewrite_proposal', 'server_apply_rewrite_proposal',
        'server_begin_regeneration_candidate', 'server_complete_regeneration_candidate',
        'server_confirm_regeneration_candidate', 'server_create_exports', 'server_finalize_export'
      ])
      and obj_description(oid, 'pg_proc') is not null
  ),
  14,
  'every B04 server RPC is commented'
);
select is(
  (
    select count(*)::integer
    from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = any(array[
        'server_create_text_source', 'server_begin_guest_generation', 'server_finish_guest_generation',
        'server_claim_generation_job', 'server_update_generation_progress', 'server_finalize_generation_job',
        'server_begin_rewrite_proposal', 'server_complete_rewrite_proposal', 'server_apply_rewrite_proposal',
        'server_begin_regeneration_candidate', 'server_complete_regeneration_candidate',
        'server_confirm_regeneration_candidate', 'server_create_exports', 'server_finalize_export'
      ])
      and prosecdef
      and proconfig @> array['search_path=""']::text[]
  ),
  14,
  'every B04 server RPC uses a fixed empty search path under definer rights'
);
select is(
  (
    select count(*)::integer
    from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = any(array[
        'server_create_text_source', 'server_begin_guest_generation', 'server_finish_guest_generation',
        'server_claim_generation_job', 'server_update_generation_progress', 'server_finalize_generation_job',
        'server_begin_rewrite_proposal', 'server_complete_rewrite_proposal', 'server_apply_rewrite_proposal',
        'server_begin_regeneration_candidate', 'server_complete_regeneration_candidate',
        'server_confirm_regeneration_candidate', 'server_create_exports', 'server_finalize_export'
      ])
      and has_function_privilege('service_role', oid, 'execute')
  ),
  14,
  'service role can execute every B04 server RPC'
);
select is(
  (
    select count(*)::integer
    from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = any(array[
        'server_create_text_source', 'server_begin_guest_generation', 'server_finish_guest_generation',
        'server_claim_generation_job', 'server_update_generation_progress', 'server_finalize_generation_job',
        'server_begin_rewrite_proposal', 'server_complete_rewrite_proposal', 'server_apply_rewrite_proposal',
        'server_begin_regeneration_candidate', 'server_complete_regeneration_candidate',
        'server_confirm_regeneration_candidate', 'server_create_exports', 'server_finalize_export'
      ])
      and has_function_privilege('authenticated', oid, 'execute')
  ),
  0,
  'authenticated clients cannot execute B04 server RPCs directly'
);
select is(
  (
    select count(*)::integer
    from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = any(array[
        'server_create_text_source', 'server_begin_guest_generation', 'server_finish_guest_generation',
        'server_claim_generation_job', 'server_update_generation_progress', 'server_finalize_generation_job',
        'server_begin_rewrite_proposal', 'server_complete_rewrite_proposal', 'server_apply_rewrite_proposal',
        'server_begin_regeneration_candidate', 'server_complete_regeneration_candidate',
        'server_confirm_regeneration_candidate', 'server_create_exports', 'server_finalize_export'
      ])
      and has_function_privilege('anon', oid, 'execute')
  ),
  0,
  'anonymous clients cannot execute B04 server RPCs directly'
);
select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname = 'public' and tablename = 'exports' and policyname = 'exports_select_own_active' and 'authenticated' = any(roles)$$,
  array[1::bigint],
  'export metadata has an owner-only read policy'
);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '71111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'b04-owner@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '72222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'b04-other@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

set local role service_role;
select lives_ok(
  $$select public.server_create_text_source(
    '71111111-1111-4111-8111-111111111111', 'topic', '{"characterCount":12}'::jsonb,
    '[{"segmentId":"segment-1","text":"Private source text"}]'::jsonb,
    now() + interval '7 days', 'source-operation-1', repeat('a', 64)
  )$$,
  'service role creates a source through the atomic RPC'
);
select lives_ok(
  $$select public.server_create_text_source(
    '71111111-1111-4111-8111-111111111111', 'topic', '{"characterCount":12}'::jsonb,
    '[{"segmentId":"segment-1","text":"Private source text"}]'::jsonb,
    now() + interval '7 days', 'source-operation-1', repeat('a', 64)
  )$$,
  'the same source request replays its receipt'
);
select results_eq(
  $$select count(*)::bigint from public.sources where owner_id = '71111111-1111-4111-8111-111111111111'$$,
  array[1::bigint],
  'source replay stores one source'
);
reset role;
select results_eq(
  $$select coalesce(response_ref ? 'segments', false) from private.operation_receipts where owner_id = '71111111-1111-4111-8111-111111111111' and operation = 'create_text_source'$$,
  array[false],
  'source receipts do not retain source text or segments'
);
set local role service_role;
select throws_ok(
  $$select public.server_create_text_source(
    '71111111-1111-4111-8111-111111111111', 'topic', '{"characterCount":9}'::jsonb,
    '[{"segmentId":"segment-2","text":"Different"}]'::jsonb,
    now() + interval '7 days', 'source-operation-1', repeat('b', 64)
  )$$,
  '23505', 'idempotency key request hash conflict',
  'the same source key cannot be reused for different input'
);
select lives_ok(
  $$select private.create_project(
    '71111111-1111-4111-8111-111111111111', 'B04 project', 'linkedin',
    '{"schemaVersion":1,"title":"B04 project","platform":"linkedin"}'::jsonb
  )$$,
  'B04 test project is created with its first snapshot'
);
select lives_ok(
  format(
    $$select * from public.server_create_exports(
      '71111111-1111-4111-8111-111111111111', %L, 1,
      array['png_zip','pdf'], '{}'::jsonb, array[]::text[], 'export-operation-1', repeat('c', 64)
    )$$,
    (select id from public.projects where owner_id = '71111111-1111-4111-8111-111111111111')
  ),
  'one transaction creates the requested basic export jobs'
);
select lives_ok(
  format(
    $$select * from public.server_create_exports(
      '71111111-1111-4111-8111-111111111111', %L, 1,
      array['png_zip','pdf'], '{}'::jsonb, array[]::text[], 'export-operation-1', repeat('c', 64)
    )$$,
    (select id from public.projects where owner_id = '71111111-1111-4111-8111-111111111111')
  ),
  'the same export request replays without duplicate jobs'
);
select results_eq(
  $$select count(*)::bigint from public.exports where owner_id = '71111111-1111-4111-8111-111111111111'$$,
  array[2::bigint],
  'export replay stores exactly one row per requested format'
);
select results_eq(
  $$select count(distinct project_version_id)::bigint from public.exports where owner_id = '71111111-1111-4111-8111-111111111111'$$,
  array[1::bigint],
  'every export is pinned to the same immutable project version'
);
select results_eq(
  $$select count(*)::bigint from public.jobs where owner_id = '71111111-1111-4111-8111-111111111111' and kind = 'export' and (input_ref ? 'document' or input_ref ? 'segments' or input_ref ? 'sourceText')$$,
  array[0::bigint],
  'export task payloads remain reference-only'
);
reset role;
insert into public.usage_accounts (owner_id, period_start, period_end, resource, granted)
values (
  '71111111-1111-4111-8111-111111111111',
  date_trunc('month', now()),
  date_trunc('month', now()) + interval '1 month',
  'generation',
  5
);
insert into private.cost_budgets (period, environment, limit_micro_usd)
values (to_char(now() at time zone 'UTC', 'YYYY-MM'), 'development', 10000000);
set local role service_role;
select lives_ok(
  format(
    $$select public.server_submit_job(
      '71111111-1111-4111-8111-111111111111', null, 'generation',
      jsonb_build_object(
        'sourceId', %L,
        'options', jsonb_build_object('language','English','format','educational','pageCount',4,'instructions','','templateId','paper','platform','linkedin')
      ),
      'generation-operation-1', repeat('d', 64), 'generation', 1,
      date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
      'development', to_char(now() at time zone 'UTC', 'YYYY-MM'), 25000
    )$$,
    (select id from public.sources where owner_id = '71111111-1111-4111-8111-111111111111')
  ),
  'generation submission atomically reserves product quota and supplier budget'
);
select lives_ok(
  format(
    $$select * from public.server_claim_generation_job(%L)$$,
    (select id from public.jobs where owner_id = '71111111-1111-4111-8111-111111111111' and kind = 'generation')
  ),
  'generation worker claims the authorized source with a new lease'
);
select results_eq(
  $$select state::text from public.jobs where owner_id = '71111111-1111-4111-8111-111111111111' and kind = 'generation'$$,
  array['running'::text],
  'claimed generation is running'
);
reset role;
select results_eq(
  $$select state::text from private.cost_attempts where reservation_id = (select id from private.cost_reservations where job_id = (select id from public.jobs where owner_id = '71111111-1111-4111-8111-111111111111' and kind = 'generation'))$$,
  array['sent'::text],
  'claim records the provider attempt before the external call'
);
set local role service_role;
select results_eq(
  $$select public.server_update_generation_progress(id, lease_token, 'outline', 20) from public.jobs where owner_id = '71111111-1111-4111-8111-111111111111' and kind = 'generation'$$,
  array[true],
  'the current lease advances generation progress'
);
select results_eq(
  $$select public.server_finalize_generation_job(id, lease_token, '{"schemaVersion":1}'::jsonb, null) from public.jobs where owner_id = '71111111-1111-4111-8111-111111111111' and kind = 'generation'$$,
  array[true],
  'the current lease atomically commits the generated document'
);
select results_eq(
  $$select state::text || ':' || progress::text || ':' || (result_ref ? 'document')::text from public.jobs where owner_id = '71111111-1111-4111-8111-111111111111' and kind = 'generation'$$,
  array['succeeded:100:true'::text],
  'generation terminal state exposes only the structured result reference'
);
select results_eq(
  $$select reserved::text || ':' || consumed::text from public.usage_accounts where owner_id = '71111111-1111-4111-8111-111111111111' and resource = 'generation'$$,
  array['0:1'::text],
  'successful generation settles exactly one product unit'
);
reset role;
select results_eq(
  $$select state::text from private.cost_reservations where job_id = (select id from public.jobs where owner_id = '71111111-1111-4111-8111-111111111111' and kind = 'generation')$$,
  array['unknown'::text],
  'missing actual provider cost remains explicitly unknown'
);
select results_eq(
  $$select reserved_micro_usd::text || ':' || spent_micro_usd::text from private.cost_budgets where environment = 'development' and period = to_char(now() at time zone 'UTC', 'YYYY-MM')$$,
  array['25000:0'::text],
  'unknown provider cost remains conservatively reserved and is never forged as spend'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '72222222-2222-4222-8222-222222222222';
select is_empty(
  $$select id from public.exports where owner_id = '71111111-1111-4111-8111-111111111111'$$,
  'another account cannot read export metadata'
);
reset role;

select * from finish(true);
rollback;
