-- T044: reference-only file workers share the existing UTC monthly cost budget.
-- [UNVERIFIED-NUMBER: $1 is a conservative reservation for a <=30 minute video,
-- not a provider price or a claim about its final bill.] Parsing itself uses no
-- generation credits. Provider calls remain unknown until real billing is reconciled.

-- The original finalizer could mark a source ready without a parse job, lease or cost
-- reservation. Keep the signature for migration compatibility but remove its only grant;
-- all worker finalization now goes through server_finalize_source_parse_job below.
revoke execute on function public.server_finalize_source_parse(uuid, uuid, jsonb, jsonb, text)
from service_role;

create or replace function public.server_claim_source_parse(p_source_id uuid, p_environment text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  source public.sources;
  work public.jobs;
  budget private.cost_budgets;
  cost_period text := to_char(now() at time zone 'UTC', 'YYYY-MM');
  reservation_amount bigint;
  failure text;
begin
  if p_environment is null or p_environment not in ('development', 'preview', 'production') then
    raise exception using errcode = '22023', message = 'invalid parse environment';
  end if;
  select * into source from public.sources where id = p_source_id for update;
  if source.id is null or source.state <> 'parsing' then
    return jsonb_build_object('sourceId', p_source_id, 'state', 'skipped');
  end if;
  -- Serialize claims for this owner as well as repeated claims for this source.
  perform 1 from public.profiles where id = source.owner_id and status = 'active' for update;
  if not found or source.expires_at <= now() then
    failure := 'SOURCE_UNAVAILABLE';
  elsif source.kind not in ('pdf', 'slides', 'video') then
    failure := 'SOURCE_UNSUPPORTED_FORMAT';
  elsif not exists (select 1 from public.assets where id = source.asset_id
    and owner_id = source.owner_id and purpose = 'source' and state = 'ready') then
    failure := 'SOURCE_UNAVAILABLE';
  end if;

  select * into work from public.jobs where owner_id = source.owner_id and kind = 'parse'
    and idempotency_key = 'source:' || source.id::text || ':parse';
  if work.id is not null then
    -- Never reclaim an uncertain provider call under a fresh lease.
    return jsonb_build_object('sourceId', source.id, 'state', 'skipped');
  end if;
  if failure is null and exists (select 1 from public.jobs where owner_id = source.owner_id
    and state in ('pending_dispatch', 'queued', 'running')) then
    failure := 'CONCURRENCY_LIMIT';
  end if;
  reservation_amount := case when source.kind = 'video' then 1000000 else 0 end;
  if failure is null and reservation_amount > 0 then
    select * into budget from private.cost_budgets
      where period = cost_period and environment = p_environment for update;
    if budget.period is null or budget.limit_micro_usd - budget.reserved_micro_usd - budget.spent_micro_usd < reservation_amount then
      failure := 'BUDGET_EXCEEDED';
    end if;
  end if;
  if failure is not null then
    update public.sources set state = 'failed', segments = '[]'::jsonb,
      metadata = metadata || jsonb_build_object('errorCode', failure, 'action', 'paste-text',
        'message', 'This source cannot be processed now. Paste its text or try again later.'), updated_at = now()
      where id = source.id;
    return jsonb_build_object('sourceId', source.id, 'state', 'failed');
  end if;

  insert into public.jobs (owner_id, kind, input_ref, idempotency_key, request_hash,
    state, stage, attempt, lease_token, heartbeat_at)
  values (source.owner_id, 'parse', jsonb_build_object('sourceId', source.id),
    'source:' || source.id::text || ':parse', md5(source.id::text),
    'running', 'parse', 1, gen_random_uuid(), now()) returning * into work;
  if reservation_amount > 0 then
    update private.cost_budgets set reserved_micro_usd = reserved_micro_usd + reservation_amount, updated_at = now()
      where period = cost_period and environment = p_environment;
  end if;
  insert into private.cost_reservations (job_id, environment, period, operation_key, reserved_micro_usd)
    values (work.id, p_environment, cost_period, 'job:' || work.id::text, reservation_amount);
  return jsonb_build_object('sourceId', source.id, 'state', 'claimed', 'jobId', work.id,
    'leaseToken', work.lease_token, 'source', jsonb_build_object('id', source.id,
      'owner_id', source.owner_id, 'kind', source.kind, 'asset_id', source.asset_id,
      'state', source.state, 'metadata', source.metadata));
end;
$$;
comment on function public.server_claim_source_parse(uuid, text) is '原子领取文件解析任务并预留视频成本；重复、过期、预算或并发不足时不执行解析且不扣用户额度';
revoke execute on function public.server_claim_source_parse(uuid, text) from public, anon, authenticated;
grant execute on function public.server_claim_source_parse(uuid, text) to service_role;

create or replace function public.server_start_source_transcription(
  p_source_id uuid, p_job_id uuid, p_lease_token uuid, p_offset_seconds numeric, p_duration_seconds numeric
)
returns void language plpgsql security definer set search_path = '' as $$
declare source public.sources; work public.jobs; reservation private.cost_reservations;
begin
  select * into source from public.sources where id = p_source_id for update;
  select * into work from public.jobs where id = p_job_id for update;
  if source.id is null or work.id is null or work.kind <> 'parse' or work.state <> 'running'
    or work.owner_id <> source.owner_id or work.input_ref ->> 'sourceId' is distinct from p_source_id::text
    or p_lease_token is null or work.lease_token is distinct from p_lease_token
    or work.cancel_requested_at is not null or source.state <> 'parsing' or source.kind <> 'video'
    or source.expires_at <= now()
    or not exists (select 1 from public.profiles where id = source.owner_id and status = 'active')
    or not exists (select 1 from public.assets where id = source.asset_id and owner_id = source.owner_id and state = 'ready') then
    raise exception using errcode = '42501', message = 'source transcription is not authorized';
  end if;
  if p_offset_seconds is null or p_duration_seconds is null or p_offset_seconds < 0
    or p_duration_seconds <= 0 or p_duration_seconds > 600
    or p_offset_seconds + p_duration_seconds > 1800 or mod(p_offset_seconds, 600) <> 0 then
    raise exception using errcode = '22023', message = 'invalid transcription chunk';
  end if;
  select * into reservation from private.cost_reservations where job_id = work.id for update;
  if reservation.id is null or reservation.state <> 'open' or reservation.reserved_micro_usd < 1000000 then
    raise exception using errcode = '22003', message = 'transcription cost is not reserved';
  end if;
  -- A second send for the same offset raises unique_violation; it is not a free retry.
  insert into private.cost_attempts (reservation_id, attempt_key, state, usage)
    values (reservation.id, 'job:' || work.id::text || ':transcribe:' || trunc(p_offset_seconds)::text,
      'sent', jsonb_build_object('offsetSeconds', p_offset_seconds, 'durationSeconds', p_duration_seconds));
  update public.jobs set stage = 'transcribe', heartbeat_at = now(), updated_at = now() where id = work.id;
end;
$$;
comment on function public.server_start_source_transcription(uuid, uuid, uuid, numeric, numeric) is '发送真实转录前复核来源和 lease、登记唯一音段成本尝试，仅存数字用量且拒绝重复发送';
revoke execute on function public.server_start_source_transcription(uuid, uuid, uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.server_start_source_transcription(uuid, uuid, uuid, numeric, numeric) to service_role;

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
    raise exception using errcode = '40001', message = 'stale worker lease';
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
comment on function public.server_finalize_source_parse_job(uuid, uuid, uuid, jsonb, jsonb, text) is '按 lease 幂等终结来源与解析任务；未调用供应商则释放预留，已发送成本保留待对账，删除或取消优先且不扣用户额度';
revoke execute on function public.server_finalize_source_parse_job(uuid, uuid, uuid, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.server_finalize_source_parse_job(uuid, uuid, uuid, jsonb, jsonb, text) to service_role;

notify pgrst, 'reload schema';
