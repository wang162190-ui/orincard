-- Keep transaction internals in the unexposed private schema while making the
-- narrow server operations reachable through the public Data API schema.

create or replace function public.server_create_project(
  p_owner_id uuid,
  p_title text,
  p_platform public.platform_preset,
  p_document jsonb
)
returns public.projects
language sql
set search_path = ''
as $$
  select private.create_project(p_owner_id, p_title, p_platform, p_document);
$$;

comment on function public.server_create_project(uuid, text, public.platform_preset, jsonb)
is '服务端经 Data API 原子创建项目及首个快照的受限入口';
revoke execute on function public.server_create_project(uuid, text, public.platform_preset, jsonb)
from public, anon, authenticated;
grant execute on function public.server_create_project(uuid, text, public.platform_preset, jsonb)
to service_role;

create or replace function public.server_save_project(
  p_owner_id uuid,
  p_project_id uuid,
  p_expected_revision bigint,
  p_title text,
  p_platform public.platform_preset,
  p_document jsonb,
  p_reason public.project_version_reason,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language sql
set search_path = ''
as $$
  select private.save_project(
    p_owner_id,
    p_project_id,
    p_expected_revision,
    p_title,
    p_platform,
    p_document,
    p_reason,
    p_idempotency_key,
    p_request_hash
  );
$$;

comment on function public.server_save_project(uuid, uuid, bigint, text, public.platform_preset, jsonb, public.project_version_reason, text, text)
is '服务端经 Data API 调用 CAS、快照和幂等回执同事务保存的受限入口';
revoke execute on function public.server_save_project(uuid, uuid, bigint, text, public.platform_preset, jsonb, public.project_version_reason, text, text)
from public, anon, authenticated;
grant execute on function public.server_save_project(uuid, uuid, bigint, text, public.platform_preset, jsonb, public.project_version_reason, text, text)
to service_role;

create or replace function public.server_submit_job(
  p_owner_id uuid,
  p_project_id uuid,
  p_kind public.job_kind,
  p_input_ref jsonb,
  p_idempotency_key text,
  p_request_hash text,
  p_resource text,
  p_units bigint,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_environment text,
  p_cost_period text,
  p_reserved_micro_usd bigint
)
returns public.jobs
language sql
set search_path = ''
as $$
  select private.submit_job(
    p_owner_id,
    p_project_id,
    p_kind,
    p_input_ref,
    p_idempotency_key,
    p_request_hash,
    p_resource,
    p_units,
    p_period_start,
    p_period_end,
    p_environment,
    p_cost_period,
    p_reserved_micro_usd
  );
$$;

comment on function public.server_submit_job(uuid, uuid, public.job_kind, jsonb, text, text, text, bigint, timestamptz, timestamptz, text, text, bigint)
is '服务端经 Data API 幂等创建任务并预留额度和成本的受限入口';
revoke execute on function public.server_submit_job(uuid, uuid, public.job_kind, jsonb, text, text, text, bigint, timestamptz, timestamptz, text, text, bigint)
from public, anon, authenticated;
grant execute on function public.server_submit_job(uuid, uuid, public.job_kind, jsonb, text, text, text, bigint, timestamptz, timestamptz, text, text, bigint)
to service_role;

create or replace function public.server_request_job_cancellation(
  p_owner_id uuid,
  p_job_id uuid
)
returns public.jobs
language sql
set search_path = ''
as $$
  select private.request_job_cancellation(p_owner_id, p_job_id);
$$;

comment on function public.server_request_job_cancellation(uuid, uuid)
is '服务端经 Data API 持久化本人任务取消请求的受限入口';
revoke execute on function public.server_request_job_cancellation(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.server_request_job_cancellation(uuid, uuid)
to service_role;

create or replace function public.server_mark_job_dispatched(
  p_job_id uuid,
  p_expected_provider_run_id text,
  p_provider_run_id text
)
returns public.jobs
language plpgsql
set search_path = ''
as $$
declare
  dispatched public.jobs;
begin
  if nullif(btrim(p_provider_run_id), '') is null then
    raise exception using errcode = '22023', message = 'provider run id is required';
  end if;

  update public.jobs
  set state = 'queued',
      provider_run_id = p_provider_run_id,
      updated_at = now()
  where id = p_job_id
    and state = 'pending_dispatch'
    and cancel_requested_at is null
    and provider_run_id is not distinct from p_expected_provider_run_id
  returning * into dispatched;

  return dispatched;
end;
$$;

comment on function public.server_mark_job_dispatched(uuid, text, text)
is '服务端以供应商运行标识 CAS 将 outbox 任务标记为已投递的受限入口';
revoke execute on function public.server_mark_job_dispatched(uuid, text, text)
from public, anon, authenticated;
grant execute on function public.server_mark_job_dispatched(uuid, text, text)
to service_role;

create or replace function public.server_claim_job_retry(
  p_owner_id uuid,
  p_job_id uuid,
  p_expected_provider_run_id text
)
returns public.jobs
language plpgsql
set search_path = ''
as $$
declare
  target public.jobs;
begin
  select * into target
  from public.jobs
  where id = p_job_id and owner_id = p_owner_id
  for update;

  if target.id is null then
    raise exception using errcode = '42501', message = 'job is not accessible';
  end if;

  if target.state in ('pending_dispatch', 'queued', 'running')
    and target.cancel_requested_at is null
    and target.provider_run_id is not distinct from p_expected_provider_run_id
    and target.attempt < 3 then
    update public.jobs
    set attempt = attempt + 1,
        state = 'pending_dispatch',
        heartbeat_at = null,
        lease_token = null,
        error_code = null,
        updated_at = now()
    where id = p_job_id
    returning * into target;
  end if;

  return target;
end;
$$;

comment on function public.server_claim_job_retry(uuid, uuid, text)
is '服务端锁定本人非终态任务并以供应商运行标识 CAS 申请有界重试的受限入口';
revoke execute on function public.server_claim_job_retry(uuid, uuid, text)
from public, anon, authenticated;
grant execute on function public.server_claim_job_retry(uuid, uuid, text)
to service_role;

notify pgrst, 'reload schema';
