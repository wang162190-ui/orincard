begin;
set local search_path = extensions, public, pg_catalog;
select plan(20);

select has_table('public', 'projects', 'projects table exists');
select has_table('public', 'project_versions', 'project_versions table exists');
select ok(obj_description('public.projects'::regclass, 'pg_class') is not null, 'projects is commented');
select is((select count(*)::integer from pg_attribute where attrelid = 'public.projects'::regclass and attnum > 0 and not attisdropped and col_description(attrelid, attnum) is not null), 11, 'every projects column is commented');
select is((select count(*)::integer from pg_attribute where attrelid = 'public.project_versions'::regclass and attnum > 0 and not attisdropped and col_description(attrelid, attnum) is not null), 7, 'every project_versions column is commented');
select ok(not has_table_privilege('anon', 'public.projects', 'select'), 'anonymous has no project access');
select ok(has_table_privilege('authenticated', 'public.projects', 'select'), 'authenticated may read authorized projects');
select ok(not has_table_privilege('authenticated', 'public.projects', 'insert'), 'authenticated clients cannot forge an owner');
select ok(has_schema_privilege('service_role', 'private', 'usage'), 'only the trusted service can resolve private transaction functions');

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '31111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'project-owner@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '32222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'project-other@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

set local role service_role;
select lives_ok(
  $$select private.create_project(
    '31111111-1111-1111-1111-111111111111', 'First project', 'linkedin',
    '{"schemaVersion":1,"title":"First project","platform":"linkedin"}'::jsonb
  )$$,
  'trusted service creates a project and revision one snapshot'
);
reset role;

select results_eq($$select count(*)::bigint from public.projects where owner_id = '31111111-1111-1111-1111-111111111111'$$, array[1::bigint], 'one project is stored');
select results_eq($$select count(*)::bigint from public.project_versions where owner_id = '31111111-1111-1111-1111-111111111111' and revision = 1$$, array[1::bigint], 'the initial immutable snapshot is stored');

set local role authenticated;
set local "request.jwt.claim.sub" = '31111111-1111-1111-1111-111111111111';
select results_eq($$select count(*)::bigint from public.projects$$, array[1::bigint], 'an owner reads their active project');
reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '32222222-2222-2222-2222-222222222222';
select is_empty($$select id from public.projects$$, 'another account cannot guess a project id');
select throws_ok(
  $$insert into public.projects (owner_id, title, platform, document) values (
    '31111111-1111-1111-1111-111111111111', 'Forged', 'linkedin',
    '{"schemaVersion":1,"title":"Forged","platform":"linkedin"}'::jsonb
  )$$,
  '42501', null, 'authenticated clients cannot forge an owner'
);
reset role;

set local role service_role;
select lives_ok(
  format(
    $$select private.save_project('31111111-1111-1111-1111-111111111111', %L, 1, 'Saved project', 'instagram', '{"schemaVersion":1,"title":"Saved project","platform":"instagram"}'::jsonb, 'manual')$$,
    (select id from public.projects where owner_id = '31111111-1111-1111-1111-111111111111')
  ),
  'the first CAS save succeeds'
);
select throws_ok(
  format(
    $$select private.save_project('31111111-1111-1111-1111-111111111111', %L, 1, 'Stale save', 'tiktok', '{"schemaVersion":1,"title":"Stale save","platform":"tiktok"}'::jsonb, 'manual')$$,
    (select id from public.projects where owner_id = '31111111-1111-1111-1111-111111111111')
  ),
  '40001', 'project revision conflict', 'two CAS saves cannot both succeed'
);
reset role;

select results_eq($$select revision from public.projects where owner_id = '31111111-1111-1111-1111-111111111111'$$, array[2::bigint], 'only one CAS update advanced the revision');
select results_eq($$select count(*)::bigint from public.project_versions where owner_id = '31111111-1111-1111-1111-111111111111'$$, array[2::bigint], 'each successful revision has one snapshot');
select throws_ok($$update public.project_versions set document = '{}'::jsonb where owner_id = '31111111-1111-1111-1111-111111111111'$$, '55000', 'project versions are immutable', 'project versions reject update and delete');
select throws_ok($$delete from public.project_versions where owner_id = '31111111-1111-1111-1111-111111111111'$$, '55000', 'project versions are immutable', 'project versions also reject deletion');

update public.profiles set status = 'deleting' where id = '31111111-1111-1111-1111-111111111111';
set local role authenticated;
set local "request.jwt.claim.sub" = '31111111-1111-1111-1111-111111111111';
select is_empty($$select id from public.projects$$, 'a deleting account cannot read projects');
select is_empty($$select id from public.project_versions$$, 'a deleting account cannot read project versions');
reset role;

select * from finish(true);
rollback;
