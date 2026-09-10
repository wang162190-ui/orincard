-- T092 defect A: business conflicts must not be raised as SQLSTATE 40001.
--
-- 40001 is serialization_failure. PostgREST treats it as a transient conflict and retries
-- the statement, but a revision mismatch or a stale worker lease is deterministic, so the
-- retry can never succeed and the HTTP request never returns. Measured against the
-- development project with a one-line probe function: 40001 hung until the 25s client
-- timeout with no response, while PT409 answered 409 in 3.5s.
--
-- PT409 is PostgREST's "raise this HTTP status" form, which is what these conditions mean:
-- the caller lost an optimistic-concurrency race and should re-read, not retry blindly.
--
-- Every function below is redefined with an unchanged signature, so existing grants and
-- revokes are preserved.

-- was 20260906000100_walking_skeleton.sql
create or replace function private.finalize_job(
  p_owner_id uuid, p_job_id uuid, p_lease_token uuid, p_requested_state public.job_state,
  p_result_ref jsonb, p_error_code text, p_delivered_units bigint, p_actual_micro_usd bigint, p_event_key text
)
returns public.jobs language plpgsql security definer set search_path = '' as $$
declare
  target_job public.jobs;
  final_state public.job_state;
  reserved_units bigint;
  usage_account_id uuid;
  reservation private.cost_reservations;
begin
  if p_requested_state not in ('succeeded', 'partial', 'failed', 'canceled') then
    raise exception using errcode = '22023', message = 'final state required';
  end if;
  select * into target_job from public.jobs where id = p_job_id and owner_id = p_owner_id for update;
  if target_job.id is null then raise exception using errcode = '42501', message = 'job is not accessible'; end if;
  if target_job.state in ('succeeded', 'partial', 'failed', 'canceled') then return target_job; end if;
  if target_job.lease_token is distinct from p_lease_token then raise exception using errcode = 'PT409', message = 'stale worker lease'; end if;
  final_state := case when target_job.cancel_requested_at is not null then 'canceled'::public.job_state else p_requested_state end;

  select account_id, units into usage_account_id, reserved_units from public.usage_ledger
  where job_id = p_job_id and kind = 'reserve' order by created_at limit 1;
  if usage_account_id is null then raise exception using errcode = '22023', message = 'usage reservation not found'; end if;
  if (final_state in ('succeeded', 'partial') and p_delivered_units <> reserved_units)
    or (final_state in ('failed', 'canceled') and p_delivered_units <> 0) then
    raise exception using errcode = '22023', message = 'delivered units do not match terminal state';
  end if;
  update public.usage_accounts
  set reserved = reserved - reserved_units,
      consumed = consumed + p_delivered_units,
      updated_at = now()
  where id = usage_account_id and reserved >= reserved_units;
  if not found then raise exception using errcode = '22003', message = 'usage reservation invariant failed'; end if;
  insert into public.usage_ledger (account_id, job_id, event_key, kind, units)
  values (usage_account_id, p_job_id, p_event_key,
    case when p_delivered_units > 0 then 'settle'::public.usage_ledger_kind else 'release'::public.usage_ledger_kind end,
    case when p_delivered_units > 0 then p_delivered_units else reserved_units end);

  select * into reservation from private.cost_reservations where job_id = p_job_id for update;
  if reservation.id is null or reservation.state not in ('open', 'unknown') or p_actual_micro_usd < 0 then
    raise exception using errcode = '22003', message = 'cost reservation invariant failed';
  end if;
  if exists (
    select 1 from private.cost_attempts
    where reservation_id = reservation.id and state in ('sent', 'unknown')
  ) or coalesce((
    select sum(actual_micro_usd) from private.cost_attempts
    where reservation_id = reservation.id and state = 'settled'
  ), 0) <> p_actual_micro_usd then
    raise exception using errcode = '22003', message = 'cost attempt audit is incomplete';
  end if;
  update private.cost_budgets
  set reserved_micro_usd = reserved_micro_usd - reservation.reserved_micro_usd,
      spent_micro_usd = spent_micro_usd + p_actual_micro_usd,
      updated_at = now()
  where period = reservation.period and environment = reservation.environment
    and reserved_micro_usd >= reservation.reserved_micro_usd;
  if not found then raise exception using errcode = '22003', message = 'cost budget invariant failed'; end if;
  update private.cost_reservations
  set settled_micro_usd = p_actual_micro_usd,
      released_micro_usd = greatest(reservation.reserved_micro_usd - p_actual_micro_usd, 0),
      state = case when p_actual_micro_usd > 0 then 'settled'::private.cost_reservation_state else 'released'::private.cost_reservation_state end,
      updated_at = now()
  where id = reservation.id;

  update public.jobs
  set state = final_state,
      progress = case when final_state in ('succeeded', 'partial') then 100 else progress end,
      result_ref = case when final_state in ('succeeded', 'partial') then p_result_ref else null end,
      error_code = case when final_state in ('failed', 'canceled') then p_error_code else null end,
      updated_at = now(), finished_at = now()
  where id = p_job_id returning * into target_job;
  return target_job;
end;
$$;

-- was 20260906000100_walking_skeleton.sql
create or replace function private.save_project(
  p_owner_id uuid, p_project_id uuid, p_expected_revision bigint, p_title text,
  p_platform public.platform_preset, p_document jsonb, p_reason public.project_version_reason,
  p_idempotency_key text, p_request_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved_project public.projects; receipt private.operation_receipts; response jsonb; operation_name text;
begin
  operation_name := 'save_project:' || p_project_id::text;
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || operation_name || ':' || p_idempotency_key, 0));
  select * into receipt from private.operation_receipts
  where owner_id = p_owner_id and operation = operation_name and idempotency_key = p_idempotency_key;
  if receipt.id is not null then
    if receipt.request_hash <> p_request_hash then raise exception using errcode = '23505', message = 'idempotency key request hash conflict'; end if;
    if receipt.expires_at <= now() then raise exception using errcode = '55000', message = 'operation receipt expired'; end if;
    if not exists (select 1 from public.projects where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived')) then
      raise exception using errcode = '42501', message = 'project is not accessible';
    end if;
    return receipt.response_ref;
  end if;
  if not exists (select 1 from public.profiles where id = p_owner_id and status = 'active') then
    raise exception using errcode = '42501', message = 'account is not active';
  end if;
  update public.projects set title = p_title, platform = p_platform, document = p_document,
    revision = revision + 1, updated_at = now()
  where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived')
    and revision = p_expected_revision
  returning * into saved_project;
  if saved_project.id is null then raise exception using errcode = 'PT409', message = 'project revision conflict'; end if;
  insert into public.project_versions (project_id, owner_id, revision, document, reason)
  values (saved_project.id, saved_project.owner_id, saved_project.revision, saved_project.document, p_reason);
  response := jsonb_build_object('projectId', saved_project.id, 'revision', saved_project.revision, 'state', saved_project.state, 'httpStatus', 200);
  insert into private.operation_receipts (owner_id, operation, idempotency_key, request_hash, status, response_ref)
  values (p_owner_id, operation_name, p_idempotency_key, p_request_hash, 'completed', response);
  return response;
end;
$$;

-- was 20260907002243_b04.sql
create or replace function public.server_finalize_generation_job(
  p_job_id uuid, p_lease_token uuid, p_document jsonb, p_error_code text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare target public.jobs;
begin
  select * into target from public.jobs where id = p_job_id and kind = 'generation' for update;
  if target.id is null then return false; end if;
  if target.state in ('succeeded', 'failed', 'canceled') then return target.state = 'succeeded'; end if;
  if target.state <> 'running' or target.lease_token is distinct from p_lease_token then
    raise exception using errcode = 'PT409', message = 'stale generation worker lease';
  end if;
  if (p_document is null) = (p_error_code is null) then
    raise exception using errcode = '22023', message = 'exactly one generation result is required';
  end if;
  perform private.b04_finish_job_with_unknown_cost(
    p_job_id, p_document is not null,
    case when p_document is null then null else jsonb_build_object('document', p_document) end,
    p_error_code
  );
  return p_document is not null and target.cancel_requested_at is null;
end;
$$;

-- was 20260907002243_b04.sql
create or replace function public.server_complete_rewrite_proposal(p_proposal_job_id uuid, p_proposal jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target public.jobs;
begin
  select * into target from public.jobs where id = p_proposal_job_id and kind = 'rewrite' for update;
  if target.id is null then raise exception using errcode = '22023', message = 'rewrite proposal job not found'; end if;
  if target.state = 'succeeded' then return target.result_ref; end if;
  if target.state <> 'running' or p_proposal ->> 'proposalJobId' <> target.id::text
    or p_proposal ->> 'projectId' <> target.project_id::text
    or (p_proposal ->> 'projectRevision')::bigint <> (target.input_ref ->> 'projectRevision')::bigint then
    raise exception using errcode = 'PT409', message = 'stale rewrite proposal completion';
  end if;
  perform private.b04_finish_job_with_unknown_cost(target.id, true, jsonb_build_object('proposal', p_proposal), null);
  return jsonb_build_object('proposal', p_proposal);
end;
$$;

-- was 20260907002243_b04.sql
create or replace function public.server_complete_regeneration_candidate(p_candidate_job_id uuid, p_candidate jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target public.jobs;
begin
  select * into target from public.jobs where id = p_candidate_job_id and kind = 'generation' for update;
  if target.id is null then raise exception using errcode = '22023', message = 'regeneration candidate job not found'; end if;
  if target.state = 'succeeded' then return target.result_ref; end if;
  if target.state <> 'running' or target.input_ref ->> 'operation' <> 'regeneration'
    or p_candidate ->> 'candidateJobId' <> target.id::text
    or p_candidate ->> 'projectId' <> target.project_id::text
    or (p_candidate ->> 'projectRevision')::bigint <> (target.input_ref ->> 'projectRevision')::bigint then
    raise exception using errcode = 'PT409', message = 'stale regeneration candidate completion';
  end if;
  perform private.b04_finish_job_with_unknown_cost(target.id, true, jsonb_build_object('candidate', p_candidate), null);
  return jsonb_build_object('candidate', p_candidate);
end;
$$;

-- was 20260909191000_b07_export_formats.sql
create or replace function public.server_create_exports(
  p_owner_id uuid, p_project_id uuid, p_expected_revision bigint, p_formats text[],
  p_options jsonb, p_confirmed_warnings text[], p_idempotency_key text, p_request_hash text
)
returns table (export_id uuid, job_id uuid, format text)
language plpgsql
security definer
set search_path = ''
as $$
declare receipt private.operation_receipts; target public.projects; version_id uuid; requested text; created_export public.exports;
  created_ids jsonb := '[]'::jsonb; operation_name text := 'create_exports:' || p_project_id::text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || operation_name || ':' || p_idempotency_key, 0));
  select * into receipt from private.operation_receipts where owner_id = p_owner_id and operation = operation_name and idempotency_key = p_idempotency_key;
  if receipt.id is not null then
    if receipt.request_hash <> p_request_hash then raise exception using errcode = '23505', message = 'idempotency key request hash conflict'; end if;
    if receipt.expires_at <= now() or not exists (
      select 1 from public.projects where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived')
    ) then raise exception using errcode = '42501', message = 'export receipt is not accessible'; end if;
    return query
      select exports.id, exports.job_id, exports.format::text from public.exports
      where exports.owner_id = p_owner_id and exports.project_id = p_project_id
        and exports.id in (select (jsonb_array_elements_text(receipt.response_ref -> 'exportIds'))::uuid)
      order by exports.created_at, exports.id;
    return;
  end if;
  if coalesce(array_length(p_formats, 1), 0) < 1 or jsonb_typeof(p_options) <> 'object'
    or exists (select 1 from unnest(p_formats) value where value not in ('png_zip', 'jpg_zip', 'pdf', 'pptx', 'mp4'))
    or (select count(*) from unnest(p_formats)) <> (select count(distinct value) from unnest(p_formats) value) then
    raise exception using errcode = '22023', message = 'invalid export request';
  end if;
  select * into target from public.projects where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived') for update;
  if target.id is null then raise exception using errcode = '42501', message = 'project is not accessible'; end if;
  if target.revision <> p_expected_revision then raise exception using errcode = 'PT409', message = 'project revision conflict'; end if;
  select id into version_id from public.project_versions
  where project_id = p_project_id and owner_id = p_owner_id and revision = p_expected_revision;
  if version_id is null then raise exception using errcode = 'PT409', message = 'project version is unavailable'; end if;
  foreach requested in array p_formats loop
    insert into public.jobs (owner_id, project_id, kind, input_ref, idempotency_key, request_hash)
    values (
      p_owner_id, p_project_id, 'export',
      jsonb_build_object('projectVersionId', version_id, 'exportId', gen_random_uuid(), 'format', requested, 'rendererVersion',
        case requested when 'pptx' then 'b07-pptx-v1' when 'mp4' then 'b07-mp4-v1' else 'b04-v1' end),
      p_idempotency_key || ':' || requested, p_request_hash
    ) returning id into job_id;
    insert into public.exports (
      id, owner_id, project_id, project_version_id, job_id, format, options, renderer_version, manifest, state
    ) values (
      (select (input_ref ->> 'exportId')::uuid from public.jobs where id = job_id),
      p_owner_id, p_project_id, version_id, job_id, requested::public.export_format,
      p_options || jsonb_build_object('confirmedWarnings', to_jsonb(p_confirmed_warnings)),
      case requested when 'pptx' then 'b07-pptx-v1' when 'mp4' then 'b07-mp4-v1' else 'b04-v1' end,
      '{}'::jsonb, 'pending'
    ) returning * into created_export;
    created_ids := created_ids || jsonb_build_array(created_export.id);
    export_id := created_export.id; format := created_export.format::text;
    return next;
  end loop;
  insert into private.operation_receipts (owner_id, operation, idempotency_key, request_hash, status, response_ref)
  values (p_owner_id, operation_name, p_idempotency_key, p_request_hash, 'completed', jsonb_build_object('exportIds', created_ids));
end;
$$;

-- was 20260907002243_b04.sql
create or replace function public.server_finalize_export(
  p_job_id uuid, p_export_id uuid, p_asset_id uuid, p_manifest jsonb,
  p_result_ref jsonb, p_finished_at timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare target_job public.jobs; target_export public.exports; target_asset public.assets;
begin
  select * into target_job from public.jobs where id = p_job_id and kind = 'export' for update;
  select * into target_export from public.exports where id = p_export_id for update;
  select * into target_asset from public.assets where id = p_asset_id for update;
  if target_job.id is null or target_export.id is null or target_asset.id is null then return false; end if;
  if target_job.state = 'succeeded' then
    return target_export.state = 'ready' and target_export.asset_id = p_asset_id and target_job.result_ref = p_result_ref;
  end if;
  if target_job.state <> 'running' or target_job.cancel_requested_at is not null
    or target_export.state <> 'pending' or target_export.job_id <> target_job.id
    or target_export.owner_id <> target_job.owner_id or target_export.project_id <> target_job.project_id
    or target_asset.owner_id <> target_job.owner_id or target_asset.bucket <> 'exports'
    or target_asset.purpose <> 'export' or target_asset.kind <> 'derived' or target_asset.state <> 'ready'
    or target_asset.rights ->> 'projectVersionId' <> target_export.project_version_id::text
    or p_result_ref ->> 'exportId' <> target_export.id::text
    or p_result_ref ->> 'assetId' <> target_asset.id::text
    or p_result_ref ->> 'projectVersionId' <> target_export.project_version_id::text
    or p_result_ref ->> 'format' <> target_export.format::text
    or jsonb_typeof(p_manifest) <> 'object' or p_finished_at > now() + interval '5 minutes' then
    raise exception using errcode = 'PT409', message = 'export finalization binding failed';
  end if;
  update public.exports set manifest = p_manifest, asset_id = p_asset_id, state = 'ready'
  where id = target_export.id;
  update public.jobs set state = 'succeeded', stage = 'upload', progress = 100, result_ref = p_result_ref,
    error_code = null, heartbeat_at = p_finished_at, updated_at = p_finished_at, finished_at = p_finished_at
  where id = target_job.id and state = 'running';
  return found;
end;
$$;

-- was 20260908110457_b05_parse_budget.sql
create or replace function public.server_finalize_source_parse_job(
  p_source_id uuid, p_job_id uuid, p_lease_token uuid, p_segments jsonb, p_metadata jsonb, p_error_code text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare source public.sources; work public.jobs; reservation private.cost_reservations; failure text; allowed boolean;
begin
  select * into source from public.sources where id = p_source_id for update;
  select * into work from public.jobs where id = p_job_id for update;
  if work.id is null or work.kind <> 'parse' or work.input_ref ->> 'sourceId' is distinct from p_source_id::text then
    raise exception using errcode = '42501', message = 'parse job is not accessible';
  end if;
  if work.state in ('succeeded', 'partial', 'failed', 'canceled') then
    return jsonb_build_object('sourceId', p_source_id, 'state',
      case when source.state in ('ready', 'failed') then source.state::text else 'skipped' end);
  end if;
  if p_lease_token is null or work.lease_token is distinct from p_lease_token then
    raise exception using errcode = 'PT409', message = 'stale worker lease';
  end if;
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object'
    or (p_error_code is not null and p_error_code !~ '^[A-Z_]{3,40}$') then
    raise exception using errcode = '22023', message = 'invalid parse finalization';
  end if;
  allowed := source.id is not null and source.owner_id = work.owner_id and source.state = 'parsing'
    and source.expires_at > now() and work.cancel_requested_at is null
    and exists (select 1 from public.profiles where id = work.owner_id and status = 'active')
    and exists (select 1 from public.assets where id = source.asset_id and owner_id = work.owner_id and state = 'ready');
  failure := case when work.cancel_requested_at is not null then 'CANCELED'
    when not allowed then 'SOURCE_UNAVAILABLE' else p_error_code end;
  if failure is null and (p_segments is null or jsonb_typeof(p_segments) <> 'array' or jsonb_array_length(p_segments) = 0) then
    raise exception using errcode = '22023', message = 'a parsed source needs at least one segment';
  end if;

  select * into reservation from private.cost_reservations where job_id = work.id for update;
  if reservation.id is null or reservation.state <> 'open' then
    raise exception using errcode = '22003', message = 'parse cost reservation is not open';
  end if;
  if exists (select 1 from private.cost_attempts where reservation_id = reservation.id and state in ('sent', 'unknown')) then
    update private.cost_attempts set state = 'unknown' where reservation_id = reservation.id and state = 'sent';
    update private.cost_reservations set state = 'unknown', updated_at = now() where id = reservation.id;
  else
    if reservation.reserved_micro_usd > 0 then
      update private.cost_budgets set reserved_micro_usd = reserved_micro_usd - reservation.reserved_micro_usd, updated_at = now()
        where period = reservation.period and environment = reservation.environment and reserved_micro_usd >= reservation.reserved_micro_usd;
      if not found then raise exception using errcode = '22003', message = 'parse cost budget invariant failed'; end if;
    end if;
    update private.cost_reservations set state = 'released', released_micro_usd = reserved_micro_usd, updated_at = now()
      where id = reservation.id;
  end if;
  -- Deletion/expiry wins over a late successful parser. No extracted text is resurrected.
  if source.state = 'parsing' then
    update public.sources set state = case when failure is null then 'ready'::public.source_state else 'failed'::public.source_state end,
      segments = case when failure is null then p_segments else '[]'::jsonb end,
      metadata = case when failure is null then p_metadata else source.metadata || jsonb_build_object(
        'errorCode', failure, 'action', coalesce(p_metadata ->> 'action', 'paste-text'),
        'message', coalesce(p_metadata ->> 'message', 'This source could not be processed. Paste its text instead.')) end,
      updated_at = now() where id = source.id returning * into source;
  end if;
  update public.jobs set state = case when work.cancel_requested_at is not null then 'canceled'::public.job_state
      when failure is null then 'succeeded'::public.job_state else 'failed'::public.job_state end,
    progress = case when failure is null then 100 else progress end,
    result_ref = case when failure is null then jsonb_build_object('sourceId', p_source_id) else null end,
    error_code = failure, finished_at = now(), updated_at = now(), lease_token = null where id = work.id;
  return jsonb_build_object('sourceId', p_source_id, 'state',
    case when source.state in ('ready', 'failed') then source.state::text else 'skipped' end);
end;
$$;

-- was 20260909210000_b07_project_restore.sql
create or replace function public.server_restore_project(
  p_owner_id uuid,
  p_project_id uuid,
  p_version_id uuid,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt private.operation_receipts;
  target public.projects;
  source_version public.project_versions;
  restored public.projects;
  response jsonb;
  operation_name text := 'restore_project:' || p_project_id::text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || operation_name || ':' || p_idempotency_key, 0));
  select * into receipt from private.operation_receipts
  where owner_id = p_owner_id and operation = operation_name and idempotency_key = p_idempotency_key;
  if receipt.id is not null then
    if receipt.request_hash <> p_request_hash then
      raise exception using errcode = '23505', message = 'idempotency key request hash conflict';
    end if;
    if receipt.expires_at <= now() or not exists (
      select 1 from public.projects where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived')
    ) then
      raise exception using errcode = '42501', message = 'restore receipt is not accessible';
    end if;
    return receipt.response_ref;
  end if;
  if not exists (select 1 from public.profiles where id = p_owner_id and status = 'active') then
    raise exception using errcode = '42501', message = 'account is not active';
  end if;
  select * into target from public.projects
  where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived')
  for update;
  if target.id is null then
    raise exception using errcode = '42501', message = 'project is not accessible';
  end if;
  if target.revision <> p_expected_revision then
    raise exception using errcode = 'PT409', message = 'project revision conflict';
  end if;
  select * into source_version from public.project_versions
  where id = p_version_id and project_id = p_project_id and owner_id = p_owner_id;
  if source_version.id is null then
    raise exception using errcode = '42501', message = 'project version is not accessible';
  end if;
  update public.projects
  set title = source_version.document ->> 'title',
      platform = (source_version.document ->> 'platform')::public.platform_preset,
      document = source_version.document,
      revision = revision + 1,
      updated_at = now()
  where id = target.id and owner_id = p_owner_id and revision = p_expected_revision
  returning * into restored;
  if restored.id is null then
    raise exception using errcode = 'PT409', message = 'project revision conflict';
  end if;
  insert into public.project_versions (project_id, owner_id, revision, document, reason)
  values (restored.id, restored.owner_id, restored.revision, restored.document, 'restore');
  response := jsonb_build_object(
    'projectId', restored.id,
    'revision', restored.revision,
    'restoredFromVersionId', source_version.id,
    'httpStatus', 200
  );
  insert into private.operation_receipts (owner_id, operation, idempotency_key, request_hash, status, response_ref)
  values (p_owner_id, operation_name, p_idempotency_key, p_request_hash, 'completed', response);
  return response;
end;
$$;

-- was 20260910093000_fix_project_duplicate_refs.sql
create or replace function private.duplicate_project(
  p_owner_id uuid,
  p_project_id uuid,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  source public.projects;
  copied public.projects;
  receipt private.operation_receipts;
  response jsonb;
  operation_name constant text := 'duplicate_project';
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || operation_name || ':' || p_idempotency_key, 0));
  select * into receipt from private.operation_receipts
  where owner_id = p_owner_id and operation = operation_name and idempotency_key = p_idempotency_key;
  if receipt.id is not null then
    if receipt.request_hash <> p_request_hash then raise exception using errcode = '23505', message = 'idempotency key request hash conflict'; end if;
    if receipt.expires_at <= now() then raise exception using errcode = '55000', message = 'operation receipt expired'; end if;
    if not exists (select 1 from public.projects where id = (receipt.response_ref ->> 'projectId')::uuid and owner_id = p_owner_id and state in ('draft', 'archived')) then
      raise exception using errcode = '42501', message = 'project is not accessible';
    end if;
    return receipt.response_ref;
  end if;
  select * into source from public.projects
  where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived') for update;
  if source.id is null then raise exception using errcode = '42501', message = 'project is not accessible'; end if;
  if source.revision <> p_expected_revision then raise exception using errcode = 'PT409', message = 'project revision conflict'; end if;
  insert into public.projects (owner_id, title, platform, document, brand_kit_id, state)
  values (p_owner_id, left(source.title || ' copy', 200), source.platform,
    jsonb_set(source.document, '{title}', to_jsonb(left(source.title || ' copy', 200))), source.brand_kit_id, 'draft')
  returning * into copied;
  insert into public.project_versions (project_id, owner_id, revision, document, reason)
  values (copied.id, p_owner_id, 1, copied.document, 'manual');
  insert into public.project_asset_refs (project_id, version_id, asset_id, slot_key)
  select copied.id, null, asset_id, slot_key from public.project_asset_refs
  where project_id = source.id and version_id is null;
  response := jsonb_build_object('projectId', copied.id, 'revision', copied.revision, 'state', copied.state, 'httpStatus', 201);
  insert into private.operation_receipts (owner_id, operation, idempotency_key, request_hash, status, response_ref)
  values (p_owner_id, operation_name, p_idempotency_key, p_request_hash, 'completed', response);
  return response;
end;
$$;

-- was 20260909220000_b07_project_library.sql
create or replace function private.archive_project(
  p_owner_id uuid,
  p_project_id uuid,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.projects;
  receipt private.operation_receipts;
  response jsonb;
  operation_name constant text := 'archive_project';
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || operation_name || ':' || p_idempotency_key, 0));
  select * into receipt from private.operation_receipts
  where owner_id = p_owner_id and operation = operation_name and idempotency_key = p_idempotency_key;
  if receipt.id is not null then
    if receipt.request_hash <> p_request_hash then
      raise exception using errcode = '23505', message = 'idempotency key request hash conflict';
    end if;
    if receipt.expires_at <= now() then
      raise exception using errcode = '55000', message = 'operation receipt expired';
    end if;
    if not exists (
      select 1 from public.projects
      where id = p_project_id and owner_id = p_owner_id and state = 'archived'
    ) then
      raise exception using errcode = '42501', message = 'project is not accessible';
    end if;
    return receipt.response_ref;
  end if;

  select * into target from public.projects
  where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived') for update;
  if target.id is null then
    raise exception using errcode = '42501', message = 'project is not accessible';
  end if;
  if target.state <> 'draft' or target.revision <> p_expected_revision then
    raise exception using errcode = 'PT409', message = 'project revision conflict';
  end if;
  update public.projects set state = 'archived', revision = revision + 1, updated_at = now()
  where id = target.id returning * into target;
  response := jsonb_build_object('projectId', target.id, 'revision', target.revision, 'state', target.state, 'httpStatus', 200);
  insert into private.operation_receipts (owner_id, operation, idempotency_key, request_hash, status, response_ref)
  values (p_owner_id, operation_name, p_idempotency_key, p_request_hash, 'completed', response);
  return response;
end;
$$;
