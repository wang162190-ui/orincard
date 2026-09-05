begin;
set local search_path = extensions, public, pg_catalog;
select plan(23);

select has_table('public', 'brand_kits', 'brand_kits table exists');
select has_table('public', 'assets', 'assets table exists');
select has_table('public', 'sources', 'sources table exists');
select has_table('public', 'project_asset_refs', 'project_asset_refs table exists');
select has_table('public', 'brand_asset_refs', 'brand_asset_refs table exists');
select is((select count(*)::integer from pg_attribute where attrelid = 'public.brand_kits'::regclass and attnum > 0 and not attisdropped and col_description(attrelid, attnum) is not null), 8, 'every brand_kits column is commented');
select is((select count(*)::integer from pg_attribute where attrelid = 'public.assets'::regclass and attnum > 0 and not attisdropped and col_description(attrelid, attnum) is not null), 20, 'every assets column is commented');
select is((select count(*)::integer from pg_attribute where attrelid = 'public.sources'::regclass and attnum > 0 and not attisdropped and col_description(attrelid, attnum) is not null), 11, 'every sources column is commented');
select is((select count(*)::integer from pg_attribute where attrelid = 'public.project_asset_refs'::regclass and attnum > 0 and not attisdropped and col_description(attrelid, attnum) is not null), 6, 'every project_asset_refs column is commented');
select is((select count(*)::integer from pg_attribute where attrelid = 'public.brand_asset_refs'::regclass and attnum > 0 and not attisdropped and col_description(attrelid, attnum) is not null), 4, 'every brand_asset_refs column is commented');
select ok(not has_table_privilege('anon', 'public.assets', 'select'), 'anonymous receives no asset metadata access');
select ok(has_table_privilege('authenticated', 'public.assets', 'select'), 'authenticated may read authorized asset metadata');
select ok(not has_table_privilege('authenticated', 'public.assets', 'insert'), 'authenticated cannot forge asset ownership');
select results_eq($$select count(*)::bigint from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'storage_download_owned_or_referenced_assets' and 'authenticated' = any(roles)$$, array[1::bigint], 'private bucket download requires identity');

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '41111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'asset-owner@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '42222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'asset-other@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

set local role service_role;
select private.create_project(
  '41111111-1111-1111-1111-111111111111', 'Asset project', 'linkedin',
  '{"schemaVersion":1,"title":"Asset project","platform":"linkedin"}'::jsonb
);
insert into public.brand_kits (id, owner_id, name) values
  ('43333333-3333-3333-3333-333333333333', '41111111-1111-1111-1111-111111111111', 'Owner brand');
insert into public.assets (id, owner_id, kind, purpose, bucket, object_key, mime, bytes, sha256, accepted_at, library_retained, state)
values
  ('44444444-4444-4444-4444-444444444444', '41111111-1111-1111-1111-111111111111', 'upload', 'media', 'assets', '41111111-1111-1111-1111-111111111111/44444444-4444-4444-4444-444444444444/v1/image.png', 'image/png', 1, repeat('a', 64), now(), false, 'ready'),
  ('45555555-5555-5555-5555-555555555555', '42222222-2222-2222-2222-222222222222', 'upload', 'media', 'assets', '42222222-2222-2222-2222-222222222222/45555555-5555-5555-5555-555555555555/v1/image.png', 'image/png', 1, repeat('b', 64), now(), true, 'ready');
select lives_ok(
  format($$insert into public.project_asset_refs (project_id, asset_id, slot_key) values (%L, '44444444-4444-4444-4444-444444444444', 'slide-1:image')$$, (select id from public.projects where owner_id = '41111111-1111-1111-1111-111111111111')),
  'same-owner project asset references are accepted'
);
select throws_ok(
  format($$insert into public.project_asset_refs (project_id, asset_id, slot_key) values (%L, '45555555-5555-5555-5555-555555555555', 'slide-1:forged')$$, (select id from public.projects where owner_id = '41111111-1111-1111-1111-111111111111')),
  '23514', 'project and asset must have the same owner', 'cross-account project asset references are rejected'
);
select lives_ok(
  $$insert into public.brand_asset_refs (brand_kit_id, asset_id, slot_key) values ('43333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', 'logo')$$,
  'same-owner brand asset references are accepted'
);
select throws_ok(
  $$insert into public.brand_asset_refs (brand_kit_id, asset_id, slot_key) values ('43333333-3333-3333-3333-333333333333', '45555555-5555-5555-5555-555555555555', 'headshot')$$,
  '23514', 'brand and asset must have the same owner', 'cross-account brand asset references are rejected'
);
select lives_ok(
  format($$insert into public.project_asset_refs (project_id, version_id, asset_id, slot_key) values (%L, %L, '44444444-4444-4444-4444-444444444444', 'slide-1:image')$$, (select id from public.projects where owner_id = '41111111-1111-1111-1111-111111111111'), (select id from public.project_versions where owner_id = '41111111-1111-1111-1111-111111111111' and revision = 1)),
  'a valid historical reference is accepted'
);
delete from public.project_asset_refs where version_id is null and asset_id = '44444444-4444-4444-4444-444444444444';
select results_eq($$select count(*)::bigint from public.project_asset_refs where asset_id = '44444444-4444-4444-4444-444444444444'$$, array[1::bigint], 'historical references keep an asset readable');
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '41111111-1111-1111-1111-111111111111';
select results_eq($$select id from public.assets order by id$$, array['44444444-4444-4444-4444-444444444444'::uuid], 'owners read only their non-deleted asset metadata');
select throws_ok($$update public.assets set rights = '{"forged":true}'::jsonb where id = '44444444-4444-4444-4444-444444444444'$$, '42501', null, 'clients cannot rewrite rights metadata');
reset role;

set local role service_role;
update public.assets set state = 'deleted' where id = '44444444-4444-4444-4444-444444444444';
reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '41111111-1111-1111-1111-111111111111';
select is_empty($$select id from public.assets where id = '44444444-4444-4444-4444-444444444444'$$, 'deleted assets are not downloadable');
reset role;

select * from finish(true);
rollback;
