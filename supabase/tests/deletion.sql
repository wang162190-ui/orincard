begin;
set local search_path = extensions, public, pg_catalog;
select plan(11);

select has_table('public', 'deletion_requests', 'deletion request table exists');
select ok(obj_description('public.deletion_requests'::regclass, 'pg_class') is not null, 'deletion request table is commented');
select is((select count(*)::integer from pg_attribute where attrelid = 'public.deletion_requests'::regclass and attnum > 0 and not attisdropped and col_description(attrelid, attnum) is not null), 9, 'every deletion request field is commented');
select ok(not has_table_privilege('authenticated', 'public.deletion_requests', 'select'), 'authenticated clients cannot inspect cleanup requests');

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '71111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'delete-owner@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '72222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'delete-other@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

set local role service_role;
select private.create_project('71111111-1111-4111-8111-111111111111', 'Delete me', 'linkedin', '{"schemaVersion":1,"title":"Delete me","platform":"linkedin"}'::jsonb);
select throws_ok(
  format($$select public.server_request_project_deletion('72222222-2222-4222-8222-222222222222', %L)$$, (select id from public.projects where owner_id = '71111111-1111-4111-8111-111111111111')),
  '42501', 'project is not accessible', 'another owner cannot request project deletion'
);
select lives_ok(
  format($$select public.server_request_project_deletion('71111111-1111-4111-8111-111111111111', %L)$$, (select id from public.projects where owner_id = '71111111-1111-4111-8111-111111111111')),
  'owner can atomically request project deletion'
);
reset role;

select results_eq($$select state::text from public.projects where owner_id = '71111111-1111-4111-8111-111111111111'$$, array['deleting'::text], 'project authorization is cut before cleanup');
select results_eq($$select count(*)::bigint from public.deletion_requests where owner_id = '71111111-1111-4111-8111-111111111111' and state = 'pending'$$, array[1::bigint], 'durable cleanup request is stored');

set local role authenticated;
set local "request.jwt.claim.sub" = '71111111-1111-4111-8111-111111111111';
select is_empty($$select id from public.projects$$, 'owner cannot read a deleting project');
reset role;

set local role service_role;
select lives_ok($$select public.server_request_account_deletion('72222222-2222-4222-8222-222222222222')$$, 'owner can request account deletion');
reset role;
select results_eq($$select status::text from public.profiles where id = '72222222-2222-4222-8222-222222222222'$$, array['deleting'::text], 'account authorization is cut before cleanup');

select * from finish(true);
rollback;
