begin;
set local search_path = extensions, public, pg_catalog;
select plan(18);

select has_table('public', 'profiles', 'profiles table exists');
select ok(
  obj_description('public.profiles'::regclass, 'pg_class') is not null,
  'profiles table has a comment'
);
select is(
  (
    select count(*)::integer
    from pg_attribute
    where attrelid = 'public.profiles'::regclass
      and attnum > 0
      and not attisdropped
      and col_description(attrelid, attnum) is not null
  ),
  6,
  'every profiles column has a comment'
);
select ok(
  has_table_privilege('authenticated', 'public.profiles', 'select'),
  'authenticated receives select access'
);
select ok(
  has_column_privilege('authenticated', 'public.profiles', 'display_name', 'update'),
  'authenticated may update display_name'
);
select ok(
  not has_column_privilege('authenticated', 'public.profiles', 'status', 'update'),
  'authenticated cannot update account status'
);
select ok(
  not has_table_privilege('anon', 'public.profiles', 'select')
    and not has_table_privilege('anon', 'public.profiles', 'insert')
    and not has_table_privilege('anon', 'public.profiles', 'update')
    and not has_table_privilege('anon', 'public.profiles', 'delete'),
  'anonymous clients receive no profile privileges'
);

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-1111-1111-111111111111',
    'authenticated',
    'authenticated',
    'identity-owner@example.invalid',
    '',
    now(),
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '22222222-2222-2222-2222-222222222222',
    'authenticated',
    'authenticated',
    'identity-other@example.invalid',
    '',
    now(),
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

select results_eq(
  $$select count(*)::bigint from public.profiles where id in (
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222'
  )$$,
  array[2::bigint],
  'auth user trigger creates one profile per user'
);

set local role anon;
select throws_ok(
  $$select * from public.profiles$$,
  '42501',
  null,
  'anonymous clients cannot read profiles'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
select results_eq(
  $$select id from public.profiles order by id$$,
  array['11111111-1111-1111-1111-111111111111'::uuid],
  'an owner reads only their active profile'
);
select is_empty(
  $$select id from public.profiles where id = '22222222-2222-2222-2222-222222222222'$$,
  'an owner cannot read another profile'
);
select results_eq(
  $$update public.profiles set display_name = 'Owner updated'
    where id = '11111111-1111-1111-1111-111111111111'
    returning display_name$$,
  array['Owner updated'::text],
  'an owner updates an allowed field'
);
select is_empty(
  $$update public.profiles set display_name = 'Cross-account update'
    where id = '22222222-2222-2222-2222-222222222222'
    returning id$$,
  'an owner cannot update another profile'
);
select throws_ok(
  $$update public.profiles set status = 'deleting'
    where id = '11111111-1111-1111-1111-111111111111'$$,
  '42501',
  null,
  'an owner cannot change account status'
);
select throws_ok(
  $$delete from public.profiles
    where id = '11111111-1111-1111-1111-111111111111'$$,
  '42501',
  null,
  'an owner cannot delete their profile row'
);
select throws_ok(
  $$update public.profiles set id = '22222222-2222-2222-2222-222222222222'
    where id = '11111111-1111-1111-1111-111111111111'$$,
  '42501',
  null,
  'an owner cannot reassign profile ownership'
);
reset role;

update public.profiles
set status = 'deleting'
where id = '11111111-1111-1111-1111-111111111111';

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
select is_empty(
  $$select id from public.profiles$$,
  'a deleting account cannot read its workspace profile'
);
select is_empty(
  $$update public.profiles set display_name = 'Must stay blocked'
    where id = '11111111-1111-1111-1111-111111111111'
    returning id$$,
  'a deleting account cannot update its workspace profile'
);
reset role;

select * from finish(true);
rollback;
