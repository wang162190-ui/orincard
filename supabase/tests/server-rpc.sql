begin;
set local search_path = extensions, public, pg_catalog;
select plan(24);

select has_function('public', 'server_create_project', array['uuid', 'text', 'public.platform_preset', 'jsonb'], 'project create RPC exists');
select has_function('public', 'server_save_project', array['uuid', 'uuid', 'bigint', 'text', 'public.platform_preset', 'jsonb', 'public.project_version_reason', 'text', 'text'], 'project save RPC exists');
select has_function('public', 'server_submit_job', array['uuid', 'uuid', 'public.job_kind', 'jsonb', 'text', 'text', 'text', 'bigint', 'timestamp with time zone', 'timestamp with time zone', 'text', 'text', 'bigint'], 'job submit RPC exists');
select has_function('public', 'server_request_job_cancellation', array['uuid', 'uuid'], 'job cancel RPC exists');
select has_function('public', 'server_mark_job_dispatched', array['uuid', 'text', 'text'], 'job dispatch RPC exists');
select has_function('public', 'server_claim_job_retry', array['uuid', 'uuid', 'text'], 'job retry RPC exists');

select ok(obj_description('public.server_create_project(uuid,text,public.platform_preset,jsonb)'::regprocedure, 'pg_proc') is not null, 'project create RPC is commented');
select ok(obj_description('public.server_save_project(uuid,uuid,bigint,text,public.platform_preset,jsonb,public.project_version_reason,text,text)'::regprocedure, 'pg_proc') is not null, 'project save RPC is commented');
select ok(obj_description('public.server_submit_job(uuid,uuid,public.job_kind,jsonb,text,text,text,bigint,timestamp with time zone,timestamp with time zone,text,text,bigint)'::regprocedure, 'pg_proc') is not null, 'job submit RPC is commented');
select ok(obj_description('public.server_request_job_cancellation(uuid,uuid)'::regprocedure, 'pg_proc') is not null, 'job cancel RPC is commented');
select ok(obj_description('public.server_mark_job_dispatched(uuid,text,text)'::regprocedure, 'pg_proc') is not null, 'job dispatch RPC is commented');
select ok(obj_description('public.server_claim_job_retry(uuid,uuid,text)'::regprocedure, 'pg_proc') is not null, 'job retry RPC is commented');

select ok(has_function_privilege('service_role', 'public.server_create_project(uuid,text,public.platform_preset,jsonb)', 'execute'), 'service role can create projects');
select ok(has_function_privilege('service_role', 'public.server_save_project(uuid,uuid,bigint,text,public.platform_preset,jsonb,public.project_version_reason,text,text)', 'execute'), 'service role can save projects');
select ok(has_function_privilege('service_role', 'public.server_submit_job(uuid,uuid,public.job_kind,jsonb,text,text,text,bigint,timestamp with time zone,timestamp with time zone,text,text,bigint)', 'execute'), 'service role can submit jobs');
select ok(has_function_privilege('service_role', 'public.server_request_job_cancellation(uuid,uuid)', 'execute'), 'service role can cancel jobs');
select ok(has_function_privilege('service_role', 'public.server_mark_job_dispatched(uuid,text,text)', 'execute'), 'service role can mark dispatch');
select ok(has_function_privilege('service_role', 'public.server_claim_job_retry(uuid,uuid,text)', 'execute'), 'service role can claim retry');

select ok(not has_function_privilege('authenticated', 'public.server_create_project(uuid,text,public.platform_preset,jsonb)', 'execute'), 'authenticated cannot call project create RPC');
select ok(not has_function_privilege('authenticated', 'public.server_save_project(uuid,uuid,bigint,text,public.platform_preset,jsonb,public.project_version_reason,text,text)', 'execute'), 'authenticated cannot call project save RPC');
select ok(not has_function_privilege('authenticated', 'public.server_submit_job(uuid,uuid,public.job_kind,jsonb,text,text,text,bigint,timestamp with time zone,timestamp with time zone,text,text,bigint)', 'execute'), 'authenticated cannot call job submit RPC');
select ok(not has_function_privilege('authenticated', 'public.server_request_job_cancellation(uuid,uuid)', 'execute'), 'authenticated cannot call job cancel RPC');
select ok(not has_function_privilege('authenticated', 'public.server_mark_job_dispatched(uuid,text,text)', 'execute'), 'authenticated cannot call job dispatch RPC');
select ok(not has_function_privilege('authenticated', 'public.server_claim_job_retry(uuid,uuid,text)', 'execute'), 'authenticated cannot call job retry RPC');

select * from finish(true);
rollback;
