begin;
set local search_path = extensions, public, pg_catalog;
select plan(10);

select has_table('public', 'tool_outputs', 'tool outputs table exists');
select ok(obj_description('public.tool_outputs'::regclass, 'pg_class') is not null, 'tool outputs table is commented');
select is((select count(*)::integer from pg_attribute where attrelid = 'public.tool_outputs'::regclass and attnum > 0 and not attisdropped and col_description(attrelid, attnum) is not null), 11, 'every tool output field is commented');
select ok(not has_table_privilege('anon', 'public.tool_outputs', 'select'), 'anonymous cannot read tool outputs');

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '81111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'tool-owner@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '82222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'tool-other@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.jobs (id, owner_id, kind, input_ref, idempotency_key, request_hash)
values ('83333333-3333-4333-8333-333333333333', '81111111-1111-4111-8111-111111111111', 'tool', '{}'::jsonb, 'tool-output-test', repeat('a', 64));

set local role service_role;
select lives_ok($$select public.server_register_tool_output(
  '84444444-4444-4444-8444-444444444444', '81111111-1111-4111-8111-111111111111', '83333333-3333-4333-8333-333333333333',
  'caption', '{"kind":"text","markdown":"Ready"}'::jsonb, null, null, now() + interval '1 day',
  null, null, null, null, null, null, null, null
)$$, 'service registers an owner-bound text output');
select throws_ok($$select public.server_register_tool_output(
  '85555555-5555-4555-8555-555555555555', '82222222-2222-4222-8222-222222222222', '83333333-3333-4333-8333-333333333333',
  'caption', '{"kind":"text","markdown":"No"}'::jsonb, null, null, now() + interval '1 day',
  null, null, null, null, null, null, null, null
)$$, '42501', 'tool job is not accessible', 'another owner cannot bind the job');
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '81111111-1111-4111-8111-111111111111';
select results_eq($$select id from public.tool_outputs$$, array['84444444-4444-4444-8444-444444444444'::uuid], 'owner reads an unexpired output');
reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '82222222-2222-4222-8222-222222222222';
select is_empty($$select id from public.tool_outputs$$, 'another owner cannot read the output');
reset role;

update public.tool_outputs set state = 'expired' where id = '84444444-4444-4444-8444-444444444444';
set local role authenticated;
set local "request.jwt.claim.sub" = '81111111-1111-4111-8111-111111111111';
select is_empty($$select id from public.tool_outputs$$, 'expired output is no longer readable');
reset role;
select ok(not has_function_privilege('authenticated', 'public.server_register_tool_output(uuid,uuid,uuid,text,jsonb,uuid,bigint,timestamptz,uuid,text,text,bigint,text,integer,integer,bigint)', 'execute'), 'authenticated cannot call output registration');

select * from finish(true);
rollback;
