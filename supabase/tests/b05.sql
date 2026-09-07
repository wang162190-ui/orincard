begin;
set local search_path = extensions, public, pg_catalog;
select plan(55);

select has_function('public', 'server_create_upload_intent', array['uuid', 'public.asset_kind', 'public.asset_purpose', 'text', 'text', 'text', 'bigint', 'text', 'text', 'text'], 'upload intent RPC exists');
select has_function('public', 'server_claim_asset_validation', array['uuid'], 'asset validation claim RPC exists');
select has_function('public', 'server_finalize_asset_validation', array['uuid', 'boolean', 'text', 'bigint', 'text', 'integer', 'integer', 'bigint', 'text'], 'asset validation finalization RPC exists');
select has_function('public', 'server_create_url_source', array['uuid', 'jsonb', 'jsonb', 'timestamp with time zone', 'text', 'text'], 'url source RPC exists');
select has_function('public', 'server_create_file_source', array['uuid', 'public.source_kind', 'uuid', 'jsonb', 'timestamp with time zone', 'text', 'text'], 'file source RPC exists');
select has_function('public', 'server_finalize_source_parse', array['uuid', 'uuid', 'jsonb', 'jsonb', 'text'], 'source parse finalization RPC exists');
select has_function('public', 'server_terminate_undispatched_job', array['uuid'], 'undispatched job termination RPC exists');

select is(
  (
    select count(*)::integer from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = any(array[
        'server_create_upload_intent', 'server_claim_asset_validation', 'server_finalize_asset_validation',
        'server_create_url_source', 'server_create_file_source', 'server_finalize_source_parse',
        'server_terminate_undispatched_job'
      ])
      and obj_description(oid, 'pg_proc') is not null
  ),
  7,
  'every B05 server RPC is commented'
);
select is(
  (
    select count(*)::integer from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = any(array[
        'server_create_upload_intent', 'server_claim_asset_validation', 'server_finalize_asset_validation',
        'server_create_url_source', 'server_create_file_source', 'server_finalize_source_parse',
        'server_terminate_undispatched_job'
      ])
      and prosecdef
      and proconfig @> array['search_path=""']::text[]
  ),
  7,
  'every B05 server RPC uses a fixed empty search path under definer rights'
);
select is(
  (
    select count(*)::integer from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = any(array[
        'server_create_upload_intent', 'server_claim_asset_validation', 'server_finalize_asset_validation',
        'server_create_url_source', 'server_create_file_source', 'server_finalize_source_parse',
        'server_terminate_undispatched_job'
      ])
      and has_function_privilege('service_role', oid, 'execute')
  ),
  7,
  'service role can execute every B05 server RPC'
);
select is(
  (
    select count(*)::integer from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = any(array[
        'server_create_upload_intent', 'server_claim_asset_validation', 'server_finalize_asset_validation',
        'server_create_url_source', 'server_create_file_source', 'server_finalize_source_parse',
        'server_terminate_undispatched_job'
      ])
      and has_function_privilege('authenticated', oid, 'execute')
  ),
  0,
  'authenticated clients cannot execute B05 server RPCs directly'
);
select is(
  (
    select count(*)::integer from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = any(array[
        'server_create_upload_intent', 'server_claim_asset_validation', 'server_finalize_asset_validation',
        'server_create_url_source', 'server_create_file_source', 'server_finalize_source_parse',
        'server_terminate_undispatched_job'
      ])
      and has_function_privilege('anon', oid, 'execute')
  ),
  0,
  'anonymous clients cannot execute B05 server RPCs directly'
);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '81111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'b05-owner@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '82222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'b05-other@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

set local role service_role;

select lives_ok(
  $$select public.server_create_upload_intent(
    '81111111-1111-4111-8111-111111111111', 'upload', 'source', 'sources',
    '81111111-1111-4111-8111-111111111111/deck.pdf', 'application/pdf', 4096, repeat('a', 64),
    'upload-intent-1', repeat('1', 64)
  )$$,
  'service role registers a declared direct upload'
);
select results_eq(
  $$select (public.server_create_upload_intent(
    '81111111-1111-4111-8111-111111111111', 'upload', 'source', 'sources',
    '81111111-1111-4111-8111-111111111111/deck.pdf', 'application/pdf', 4096, repeat('a', 64),
    'upload-intent-1', repeat('1', 64)
  ) ->> 'assetId')::uuid$$,
  $$select id from public.assets where object_key = '81111111-1111-4111-8111-111111111111/deck.pdf'$$,
  'replaying the upload intent returns the same asset instead of a second row'
);
select throws_ok(
  $$select public.server_create_upload_intent(
    '81111111-1111-4111-8111-111111111111', 'upload', 'source', 'sources',
    '81111111-1111-4111-8111-111111111111/other.pdf', 'application/pdf', 4096, repeat('a', 64),
    'upload-intent-1', repeat('2', 64)
  )$$,
  '23505',
  'idempotency key request hash conflict',
  'reusing an upload key for a different file is rejected'
);
select throws_ok(
  $$select public.server_create_upload_intent(
    '81111111-1111-4111-8111-111111111111', 'upload', 'source', 'sources',
    '82222222-2222-4222-8222-222222222222/stolen.pdf', 'application/pdf', 4096, repeat('a', 64),
    'upload-intent-2', repeat('3', 64)
  )$$,
  '22023',
  'invalid upload intent',
  'an object key under another owner prefix is rejected'
);
select throws_ok(
  $$select public.server_create_upload_intent(
    '81111111-1111-4111-8111-111111111111', 'upload', 'source', 'assets',
    '81111111-1111-4111-8111-111111111111/mismatch.pdf', 'application/pdf', 4096, repeat('a', 64),
    'upload-intent-3', repeat('4', 64)
  )$$,
  '22023',
  'invalid upload intent',
  'a source upload cannot be pointed at the media bucket'
);
select results_eq(
  $$select state::text from public.assets where object_key = '81111111-1111-4111-8111-111111111111/deck.pdf'$$,
  array['pending_upload'],
  'a declared upload is not usable before it is validated'
);

select results_eq(
  $$select count(*)::bigint from public.server_claim_asset_validation(
    (select id from public.assets where object_key = '81111111-1111-4111-8111-111111111111/deck.pdf')
  )$$,
  array[1::bigint],
  'the validation task claims a pending upload'
);
select results_eq(
  $$select count(*)::bigint from public.server_claim_asset_validation(
    (select id from public.assets where object_key = '81111111-1111-4111-8111-111111111111/deck.pdf')
  )$$,
  array[0::bigint],
  'a second claim of the same upload returns nothing to work on'
);
select results_eq(
  $$select state::text from public.assets where object_key = '81111111-1111-4111-8111-111111111111/deck.pdf'$$,
  array['validating'],
  'claiming moves the asset into validation'
);

select throws_ok(
  $$select public.server_finalize_asset_validation(
    (select id from public.assets where object_key = '81111111-1111-4111-8111-111111111111/deck.pdf'),
    true, 'application/pdf', 4096, repeat('f', 64), null, null, null, null
  )$$,
  '22023',
  'uploaded object does not match the declared digest',
  'an upload whose digest differs from the declared one cannot be accepted'
);
select throws_ok(
  $$select public.server_finalize_asset_validation(
    (select id from public.assets where object_key = '81111111-1111-4111-8111-111111111111/deck.pdf'),
    false, null, null, null, null, null, null, 'not a safe code'
  )$$,
  '22023',
  'a safe error code is required',
  'a free-form failure reason cannot be written onto an asset'
);
select lives_ok(
  $$select public.server_finalize_asset_validation(
    (select id from public.assets where object_key = '81111111-1111-4111-8111-111111111111/deck.pdf'),
    true, 'application/pdf', 4096, repeat('a', 64), null, null, null, null
  )$$,
  'a matching upload is accepted'
);
select results_eq(
  $$select state::text, error_code from public.assets where object_key = '81111111-1111-4111-8111-111111111111/deck.pdf'$$,
  $$values ('ready', null::text)$$,
  'the validated upload is ready and carries no error'
);
select results_eq(
  $$select (public.server_finalize_asset_validation(
    (select id from public.assets where object_key = '81111111-1111-4111-8111-111111111111/deck.pdf'),
    false, null, null, null, null, null, null, 'REPLAY'
  )).state::text$$,
  array['ready'],
  'finalizing an already decided asset does not reopen it'
);

select lives_ok(
  $$select public.server_create_upload_intent(
    '81111111-1111-4111-8111-111111111111', 'upload', 'source', 'sources',
    '81111111-1111-4111-8111-111111111111/broken.pdf', 'application/pdf', 2048, repeat('b', 64),
    'upload-intent-4', repeat('5', 64)
  )$$,
  'a second declared upload is registered'
);
select results_eq(
  $$select count(*)::bigint from public.server_claim_asset_validation(
    (select id from public.assets where object_key = '81111111-1111-4111-8111-111111111111/broken.pdf')
  )$$,
  array[1::bigint],
  'the validation task claims the second upload'
);
select lives_ok(
  $$select public.server_finalize_asset_validation(
    (select id from public.assets where object_key = '81111111-1111-4111-8111-111111111111/broken.pdf'),
    false, null, null, null, null, null, null, 'FILE_UNREADABLE'
  )$$,
  'a file that fails validation is recorded as failed'
);
select results_eq(
  $$select state::text, error_code from public.assets where object_key = '81111111-1111-4111-8111-111111111111/broken.pdf'$$,
  $$values ('failed', 'FILE_UNREADABLE')$$,
  'the failed upload keeps a safe error class'
);

select lives_ok(
  $$select public.server_create_url_source(
    '81111111-1111-4111-8111-111111111111',
    '{"characterCount":19,"publicUrl":"https://example.invalid/post","title":"Post"}'::jsonb,
    '[{"segmentId":"segment-1","text":"Imported public text"}]'::jsonb,
    now() + interval '7 days', 'url-source-1', repeat('6', 64)
  )$$,
  'service role saves a fetched public url source'
);
select results_eq(
  $$select kind::text, state::text from public.sources where metadata ->> 'publicUrl' = 'https://example.invalid/post'$$,
  $$values ('url', 'ready')$$,
  'a parsed url source is immediately usable'
);
select throws_ok(
  $$select public.server_create_url_source(
    '81111111-1111-4111-8111-111111111111',
    '{"characterCount":0,"publicUrl":"https://example.invalid/empty"}'::jsonb,
    '[]'::jsonb, now() + interval '7 days', 'url-source-2', repeat('7', 64)
  )$$,
  '22023',
  'invalid url source',
  'a url that yielded no text cannot be stored as a usable source'
);
select throws_ok(
  $$select public.server_create_url_source(
    '81111111-1111-4111-8111-111111111111',
    '{"characterCount":5,"publicUrl":"http://127.0.0.1/admin"}'::jsonb,
    '[{"segmentId":"segment-1","text":"secret"}]'::jsonb,
    now() + interval '7 days', 'url-source-3', repeat('8', 64)
  )$$,
  '22023',
  'invalid url source',
  'a non-https link is refused at the database boundary as well'
);
select results_eq(
  $$select (public.server_create_url_source(
    '81111111-1111-4111-8111-111111111111',
    '{"characterCount":19,"publicUrl":"https://example.invalid/post","title":"Post"}'::jsonb,
    '[{"segmentId":"segment-1","text":"Imported public text"}]'::jsonb,
    now() + interval '7 days', 'url-source-1', repeat('6', 64)
  ) ->> 'sourceId')::uuid$$,
  $$select id from public.sources where metadata ->> 'publicUrl' = 'https://example.invalid/post'$$,
  'replaying a url source returns the first one'
);

select throws_ok(
  $$select public.server_create_file_source(
    '81111111-1111-4111-8111-111111111111', 'pdf',
    (select id from public.assets where object_key = '81111111-1111-4111-8111-111111111111/broken.pdf'),
    '{}'::jsonb, now() + interval '7 days', 'file-source-1', repeat('9', 64)
  )$$,
  '42501',
  'source file is not available',
  'a file that failed validation cannot become a source'
);
select lives_ok(
  $$select public.server_create_file_source(
    '81111111-1111-4111-8111-111111111111', 'pdf',
    (select id from public.assets where object_key = '81111111-1111-4111-8111-111111111111/deck.pdf'),
    '{"characterCount":0,"pageCount":12}'::jsonb, now() + interval '7 days', 'file-source-2', repeat('a', 64)
  )$$,
  'a validated file becomes a source waiting to be parsed'
);
select results_eq(
  $$select state::text, jsonb_array_length(segments) from public.sources where kind = 'pdf'$$,
  $$values ('parsing', 0)$$,
  'an unparsed file source holds no segments and is not ready'
);

select throws_ok(
  $$select public.server_finalize_source_parse(
    (select id from public.sources where kind = 'pdf'),
    '81111111-1111-4111-8111-111111111111', '[]'::jsonb, '{"characterCount":0,"pageCount":12}'::jsonb, null
  )$$,
  '22023',
  'a parsed source needs at least one segment',
  'a scan with no text layer cannot be marked ready with an empty result'
);
select lives_ok(
  $$select public.server_finalize_source_parse(
    (select id from public.sources where kind = 'pdf'),
    '81111111-1111-4111-8111-111111111111',
    '[{"segmentId":"segment-1","text":"Page one text","locator":{"kind":"page","page":1}}]'::jsonb,
    '{"characterCount":13,"pageCount":12}'::jsonb, null
  )$$,
  'a parsed pdf source becomes ready'
);
select results_eq(
  $$select state::text, jsonb_array_length(segments) from public.sources where kind = 'pdf'$$,
  $$values ('ready', 1)$$,
  'the parsed source carries its segments'
);
select results_eq(
  $$select (public.server_finalize_source_parse(
    (select id from public.sources where kind = 'pdf'),
    '81111111-1111-4111-8111-111111111111', '[]'::jsonb, '{}'::jsonb, 'SOURCE_EMPTY'
  ) ->> 'state')$$,
  array['ready'],
  'finalizing an already parsed source does not erase it'
);

select lives_ok(
  $$select public.server_create_file_source(
    '81111111-1111-4111-8111-111111111111', 'slides',
    (select id from public.assets where object_key = '81111111-1111-4111-8111-111111111111/deck.pdf'),
    '{"characterCount":0}'::jsonb, now() + interval '7 days', 'file-source-3', repeat('b', 64)
  )$$,
  'a second file source is registered for the failure path'
);
select lives_ok(
  $$select public.server_finalize_source_parse(
    (select id from public.sources where kind = 'slides'),
    '81111111-1111-4111-8111-111111111111', '[]'::jsonb, '{"characterCount":0}'::jsonb, 'SOURCE_NO_TEXT_LAYER'
  )$$,
  'a source that could not be parsed is recorded as failed'
);
select results_eq(
  $$select state::text, metadata ->> 'errorCode', jsonb_array_length(segments) from public.sources where kind = 'slides'$$,
  $$values ('failed', 'SOURCE_NO_TEXT_LAYER', 0)$$,
  'the failed source keeps a safe reason and no extracted text'
);

reset role;
insert into public.usage_accounts (owner_id, period_start, period_end, resource, granted)
values ('81111111-1111-4111-8111-111111111111', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 'generation', 3);
insert into private.cost_budgets (period, environment, limit_micro_usd)
values (to_char(now() at time zone 'utc', 'YYYY-MM'), 'development', 1000)
on conflict (period, environment) do update
set limit_micro_usd = excluded.limit_micro_usd,
    reserved_micro_usd = 0,
    spent_micro_usd = 0;
set local role service_role;

select lives_ok(
  $$select private.submit_job(
    '81111111-1111-4111-8111-111111111111', null, 'generation', '{"sourceId":"pending"}'::jsonb,
    'b05-cancel-1', repeat('c', 64), 'generation', 1,
    date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
    'development', to_char(now() at time zone 'utc', 'YYYY-MM'), 100
  )$$,
  'a generation job is submitted and reserves quota'
);
select throws_ok(
  $$select public.server_terminate_undispatched_job(
    (select id from public.jobs where idempotency_key = 'b05-cancel-1')
  )$$,
  '42501',
  'job was already dispatched or was not cancelled',
  'a job nobody asked to cancel is not terminated'
);
select lives_ok(
  $$select public.server_terminate_undispatched_job(
    (select id from (
      select (private.request_job_cancellation(
        '81111111-1111-4111-8111-111111111111',
        (select id from public.jobs where idempotency_key = 'b05-cancel-1')
      )).id
    ) as cancelled)
  )$$,
  'a job cancelled before dispatch is terminated instead of holding the slot'
);
select results_eq(
  $$select state::text, error_code, finished_at is not null from public.jobs where idempotency_key = 'b05-cancel-1'$$,
  $$values ('canceled', 'CANCELED', true)$$,
  'the never-dispatched job reaches a terminal state'
);
select results_eq(
  $$select reserved, consumed from public.usage_accounts where owner_id = '81111111-1111-4111-8111-111111111111'$$,
  $$values (0::bigint, 0::bigint)$$,
  'terminating the undispatched job gives the reserved quota back'
);
select results_eq(
  $$select kind::text, units from public.usage_ledger
    where job_id = (select id from public.jobs where idempotency_key = 'b05-cancel-1') and kind = 'release'$$,
  $$values ('release', 1::bigint)$$,
  'the release is written to the append-only ledger'
);
select results_eq(
  $$select (public.server_terminate_undispatched_job(
    (select id from public.jobs where idempotency_key = 'b05-cancel-1')
  )).state::text$$,
  array['canceled'],
  'terminating the same job twice is harmless'
);
select lives_ok(
  $$select private.submit_job(
    '81111111-1111-4111-8111-111111111111', null, 'generation', '{"sourceId":"running"}'::jsonb,
    'b05-cancel-2', repeat('d', 64), 'generation', 1,
    date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
    'development', to_char(now() at time zone 'utc', 'YYYY-MM'), 100
  )$$,
  'a second generation job is submitted'
);
select lives_ok(
  $$update public.jobs set state = 'running', lease_token = gen_random_uuid(),
    cancel_requested_at = now() where idempotency_key = 'b05-cancel-2'$$,
  'the second job is moved to running with a cancellation requested'
);
select throws_ok(
  $$select public.server_terminate_undispatched_job(
    (select id from public.jobs where idempotency_key = 'b05-cancel-2')
  )$$,
  '42501',
  'job was already dispatched or was not cancelled',
  'a job a worker already holds must finish through its lease, not this path'
);

select * from finish();
rollback;
