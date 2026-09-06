begin;
set local search_path = extensions, public, pg_catalog;
select plan(29);

select has_function('public', 'server_create_project', array['uuid', 'text', 'public.platform_preset', 'jsonb', 'text', 'text'], 'project create RPC exists');
select has_function('public', 'server_save_project', array['uuid', 'uuid', 'bigint', 'text', 'public.platform_preset', 'jsonb', 'public.project_version_reason', 'text', 'text'], 'project save RPC exists');
select has_function('public', 'server_submit_job', array['uuid', 'uuid', 'public.job_kind', 'jsonb', 'text', 'text', 'text', 'bigint', 'timestamp with time zone', 'timestamp with time zone', 'text', 'text', 'bigint'], 'job submit RPC exists');
select has_function('public', 'server_request_job_cancellation', array['uuid', 'uuid'], 'job cancel RPC exists');
select has_function('public', 'server_mark_job_dispatched', array['uuid', 'text', 'text'], 'job dispatch RPC exists');
select has_function('public', 'server_claim_job_retry', array['uuid', 'uuid', 'text'], 'job retry RPC exists');

select ok(obj_description('public.server_create_project(uuid,text,public.platform_preset,jsonb,text,text)'::regprocedure, 'pg_proc') is not null, 'project create RPC is commented');
select ok(obj_description('public.server_save_project(uuid,uuid,bigint,text,public.platform_preset,jsonb,public.project_version_reason,text,text)'::regprocedure, 'pg_proc') is not null, 'project save RPC is commented');
select ok(obj_description('public.server_submit_job(uuid,uuid,public.job_kind,jsonb,text,text,text,bigint,timestamp with time zone,timestamp with time zone,text,text,bigint)'::regprocedure, 'pg_proc') is not null, 'job submit RPC is commented');
select ok(obj_description('public.server_request_job_cancellation(uuid,uuid)'::regprocedure, 'pg_proc') is not null, 'job cancel RPC is commented');
select ok(obj_description('public.server_mark_job_dispatched(uuid,text,text)'::regprocedure, 'pg_proc') is not null, 'job dispatch RPC is commented');
select ok(obj_description('public.server_claim_job_retry(uuid,uuid,text)'::regprocedure, 'pg_proc') is not null, 'job retry RPC is commented');

select ok(has_function_privilege('service_role', 'public.server_create_project(uuid,text,public.platform_preset,jsonb,text,text)', 'execute'), 'service role can create projects');
select ok(has_function_privilege('service_role', 'public.server_save_project(uuid,uuid,bigint,text,public.platform_preset,jsonb,public.project_version_reason,text,text)', 'execute'), 'service role can save projects');
select ok(has_function_privilege('service_role', 'public.server_submit_job(uuid,uuid,public.job_kind,jsonb,text,text,text,bigint,timestamp with time zone,timestamp with time zone,text,text,bigint)', 'execute'), 'service role can submit jobs');
select ok(has_function_privilege('service_role', 'public.server_request_job_cancellation(uuid,uuid)', 'execute'), 'service role can cancel jobs');
select ok(has_function_privilege('service_role', 'public.server_mark_job_dispatched(uuid,text,text)', 'execute'), 'service role can mark dispatch');
select ok(has_function_privilege('service_role', 'public.server_claim_job_retry(uuid,uuid,text)', 'execute'), 'service role can claim retry');

select ok(not has_function_privilege('authenticated', 'public.server_create_project(uuid,text,public.platform_preset,jsonb,text,text)', 'execute'), 'authenticated cannot call project create RPC');
select ok(not has_function_privilege('authenticated', 'public.server_save_project(uuid,uuid,bigint,text,public.platform_preset,jsonb,public.project_version_reason,text,text)', 'execute'), 'authenticated cannot call project save RPC');
select ok(not has_function_privilege('authenticated', 'public.server_submit_job(uuid,uuid,public.job_kind,jsonb,text,text,text,bigint,timestamp with time zone,timestamp with time zone,text,text,bigint)', 'execute'), 'authenticated cannot call job submit RPC');
select ok(not has_function_privilege('authenticated', 'public.server_request_job_cancellation(uuid,uuid)', 'execute'), 'authenticated cannot call job cancel RPC');
select ok(not has_function_privilege('authenticated', 'public.server_mark_job_dispatched(uuid,text,text)', 'execute'), 'authenticated cannot call job dispatch RPC');
select ok(not has_function_privilege('authenticated', 'public.server_claim_job_retry(uuid,uuid,text)', 'execute'), 'authenticated cannot call job retry RPC');

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '61111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'server-rpc@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

set local role service_role;
select lives_ok(
  $$select public.server_create_project(
    '61111111-1111-1111-1111-111111111111', 'RPC project', 'linkedin',
    '{"schemaVersion":1,"title":"RPC project","platform":"linkedin"}'::jsonb,
    'create-1', repeat('a', 32)
  )$$,
  'service role creates a project through the public RPC'
);
select lives_ok(
  $$select public.server_create_project(
    '61111111-1111-1111-1111-111111111111', 'RPC project', 'linkedin',
    '{"schemaVersion":1,"title":"RPC project","platform":"linkedin"}'::jsonb,
    'create-1', repeat('a', 32)
  )$$,
  'the same create request replays its receipt'
);
select throws_ok(
  $$select public.server_create_project(
    '61111111-1111-1111-1111-111111111111', 'Different project', 'instagram',
    '{"schemaVersion":1,"title":"Different project","platform":"instagram"}'::jsonb,
    'create-1', repeat('b', 32)
  )$$,
  '23505', 'idempotency key request hash conflict',
  'the same key cannot be reused for different project input'
);
reset role;

select results_eq(
  $$select count(*)::bigint from public.projects where owner_id = '61111111-1111-1111-1111-111111111111'$$,
  array[1::bigint],
  'create replay stores one project'
);
select results_eq(
  $$select count(*)::bigint from private.operation_receipts where owner_id = '61111111-1111-1111-1111-111111111111' and operation = 'create_project'$$,
  array[1::bigint],
  'create replay stores one receipt'
);

select * from finish(true);
rollback;
