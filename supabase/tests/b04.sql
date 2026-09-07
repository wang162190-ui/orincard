begin;
set local search_path = extensions, public, pg_catalog;
select plan(28);

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
  15,
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
select has_function('public', 'server_begin_guest_generation', array['text', 'text', 'text', 'timestamp with time zone', 'timestamp with time zone', 'text', 'text', 'bigint', 'integer'], 'guest request guard RPC exists');
select has_function('public', 'server_finish_guest_generation', array['uuid', 'text'], 'guest request settlement RPC exists');
select has_function('public', 'server_claim_generation_job', array['uuid'], 'generation claim RPC exists');
select has_function('public', 'server_update_generation_progress', array['uuid', 'uuid', 'text', 'integer'], 'generation progress RPC exists');
select has_function('public', 'server_finalize_generation_job', array['uuid', 'uuid', 'jsonb', 'text'], 'generation finalization RPC exists');
select has_function('public', 'server_begin_rewrite_proposal', array['uuid', 'uuid', 'text', 'text', 'jsonb', 'text'], 'rewrite proposal begin RPC exists');
select has_function('public', 'server_complete_rewrite_proposal', array['uuid', 'jsonb'], 'rewrite proposal completion RPC exists');
select has_function('public', 'server_apply_rewrite_proposal', array['uuid', 'uuid', 'bigint', 'bigint', 'text', 'text'], 'rewrite proposal apply RPC exists');
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

select * from finish(true);
rollback;
