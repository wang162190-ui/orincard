-- 编辑器助手（AC-012）第二步：对话轮的存储与结算。
--
-- 三条刻意的取舍，先写在这里，免得下一个人以为是漏了：
--
-- 1. **对话正文只存 public.copilot_turns**，不进 jobs.input_ref，也不进 Trigger 载荷。
--    与 src/app/api/v1/agent/route.ts 的既有口径一致：任务表存的是账目与状态，不是内容。
-- 2. **每轮只有一次模型调用**，因此 attempt_key 恒为 `job:<id>:copilot:1`，
--    与 src/server/cost.ts 对 sequence 的三条既有约定相符。
-- 3. 助手提出的改动**不在这里落地**。它复用既有的 rewrite 候选（server_begin_rewrite_proposal
--    / server_complete_rewrite_proposal / server_apply_rewrite_proposal），因为
--    server_apply_rewrite_proposal 硬性要求 jobs.kind = 'rewrite'，而 AC-012 要求确认动作
--    打到既有的 apply 入口、不新开写路径。代价是**一轮带改动的对话扣 2 个 generation 单位**
--    （1 对话 + 1 候选），这是明码标价的，不是账目漏算。

create table if not exists public.copilot_turns (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete cascade,
  -- 产生这一轮的对话任务。用户轮与助手轮共用同一个 job_id，所以这里**不是** unique。
  job_id uuid not null references public.jobs (id) on delete restrict,
  role text not null check (role in ('user', 'assistant')),
  -- 两侧都按不可信输入处理：用户消息不得当作指令执行，模型回复不得当作 HTML 渲染。
  content text not null check (length(btrim(content)) between 1 and 4000),
  -- 该轮附带的 rewrite 候选。null 表示这一轮只是回答，没有提改动。
  proposal_job_id uuid references public.jobs (id) on delete set null,
  created_at timestamptz not null default now(),
  -- 用户轮不可能自带提议：提议是助手产出的。
  constraint copilot_turns_proposal_role_check check (role = 'assistant' or proposal_job_id is null)
);

comment on table public.copilot_turns is '编辑器助手的对话轮；对话正文只存这里，不进任务表与 Trigger 载荷';
comment on column public.copilot_turns.id is '对话轮唯一标识';
comment on column public.copilot_turns.owner_id is '对话所有者标识';
comment on column public.copilot_turns.project_id is '该轮所属项目';
comment on column public.copilot_turns.job_id is '产生该轮的对话任务；用户轮与助手轮共用同一个';
comment on column public.copilot_turns.role is '该轮的发言方：user 或 assistant';
comment on column public.copilot_turns.content is '该轮正文，按不可信输入处理';
comment on column public.copilot_turns.proposal_job_id is '该轮附带的 rewrite 候选任务，无改动时为空';
comment on column public.copilot_turns.created_at is '该轮创建时间（UTC）';

create index if not exists copilot_turns_project_created_idx
  on public.copilot_turns (project_id, created_at);

alter table public.copilot_turns enable row level security;
revoke all on table public.copilot_turns from anon, authenticated, service_role;
grant select on table public.copilot_turns to authenticated;
grant select, insert, update, delete on table public.copilot_turns to service_role;
drop policy if exists copilot_turns_select_own on public.copilot_turns;
create policy copilot_turns_select_own on public.copilot_turns for select to authenticated using (
  (select auth.uid()) = owner_id
  and exists (select 1 from public.profiles where id = (select auth.uid()) and status = 'active')
);

-- --- 开启一轮：**在调模型之前**预留 --------------------------------------------------------
-- 形状照抄 private.b04_begin_ai_candidate_job 的调用方（server_begin_rewrite_proposal），
-- 只把 kind 换成 'copilot'。预留 1 个 generation 单位 + 25000 µUSD，
-- 尝试行登记为 `job:<id>:copilot:1`——由 b04 内部按 ':candidate:1' 登记后，
-- 本函数改写成 copilot 序号，好让 settleKeyedJobUsage 的 operation='copilot' 对得上。
--
-- 额度或预算不足时返回 quota_exceeded / budget_exceeded，调用方必须直接 429 且
-- **不发生模型调用**——这正是 T097 的验收点：预算打满后下一轮被拒绝，而不是照跑一次再说。
create or replace function public.server_begin_copilot_turn(
  p_owner_id uuid, p_project_id uuid, p_environment text, p_idempotency_key text,
  p_input_ref jsonb, p_request_hash text, p_message text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; current_revision bigint; new_job_id uuid;
begin
  if length(btrim(coalesce(p_message, ''))) not between 1 and 4000 then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  select revision into current_revision from public.projects
  where id = p_project_id and owner_id = p_owner_id and state in ('draft', 'archived');
  if current_revision is null then return jsonb_build_object('outcome', 'not_found'); end if;
  if current_revision <> (p_input_ref ->> 'projectRevision')::bigint then
    return jsonb_build_object('outcome', 'stale');
  end if;

  result := private.b04_begin_ai_candidate_job(
    p_owner_id, p_project_id, 'copilot', p_input_ref, p_idempotency_key, p_request_hash, p_environment
  );
  if result ->> 'outcome' = 'idempotency_conflict' then return jsonb_build_object('outcome', 'conflict'); end if;
  if result ->> 'outcome' = 'replay' then
    return jsonb_build_object('outcome', 'replay', 'jobId', result ->> 'jobId', 'result', result -> 'result');
  end if;
  if result ->> 'outcome' <> 'accepted' then return result; end if;

  new_job_id := (result ->> 'jobId')::uuid;
  -- b04 用 ':candidate:1' 登记尝试行；这条链路的 operation 是 'copilot'，
  -- 不改名的话 settleKeyedJobUsage 会找不到行，实测用量被扔掉、预留永远挂着。
  update private.cost_attempts set attempt_key = 'job:' || new_job_id::text || ':copilot:1'
  where attempt_key = 'job:' || new_job_id::text || ':candidate:1';

  -- 用户那一轮当场落库：模型调用可能失败，但用户确实说过这句话。
  insert into public.copilot_turns (owner_id, project_id, job_id, role, content)
  values (p_owner_id, p_project_id, new_job_id, 'user', btrim(p_message));

  return jsonb_build_object('outcome', 'accepted', 'jobId', new_job_id);
end;
$$;

comment on function public.server_begin_copilot_turn(uuid, uuid, text, text, jsonb, text, text) is
  '为助手一轮对话原子预留额度与保守成本，并落下用户那一轮；正文不进任务表';
revoke execute on function public.server_begin_copilot_turn(uuid, uuid, text, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.server_begin_copilot_turn(uuid, uuid, text, text, jsonb, text, text)
  to service_role;

-- --- 收尾：精确结算优先，审计不过才保守兜底 -------------------------------------------------
-- 与 public.server_finalize_tool_job（20260915003000）逐条同构：先 private.finalize_job_reservation
-- 把实测用量结进 spent，再交给 b04 收用量与终态。
--
-- **不写裸 `update jobs set state='succeeded'`**：那样 usage_accounts.reserved 永远不归还，
-- 这正是交接 §4 记下的那个坑。失败路径同样要结算——token 已经烧掉了。
create or replace function public.server_finalize_copilot_turn(
  p_job_id uuid, p_owner_id uuid, p_reply text, p_proposal_job_id uuid, p_error_code text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare target public.jobs;
begin
  select * into target from public.jobs
  where id = p_job_id and owner_id = p_owner_id and kind = 'copilot' for update;
  if target.id is null then return false; end if;
  -- 重复收尾是正常结果：如实回报既有终态，不再动账、也不再插一条重复的助手轮。
  if target.state in ('succeeded', 'partial', 'failed', 'canceled') then
    return target.state = 'succeeded';
  end if;
  if (p_reply is null) = (p_error_code is null) then
    raise exception using errcode = '22023', message = 'exactly one copilot result is required';
  end if;

  perform private.finalize_job_reservation(p_job_id);
  perform private.b04_finish_job_with_unknown_cost(
    p_job_id, p_error_code is null,
    case when p_error_code is null
      then jsonb_build_object('reply', p_reply, 'proposalJobId', p_proposal_job_id)
      else null end,
    p_error_code
  );

  if p_error_code is null then
    insert into public.copilot_turns (owner_id, project_id, job_id, role, content, proposal_job_id)
    values (p_owner_id, target.project_id, p_job_id, 'assistant', btrim(p_reply), p_proposal_job_id);
  end if;
  return p_error_code is null and target.cancel_requested_at is null;
end;
$$;

comment on function public.server_finalize_copilot_turn(uuid, uuid, text, uuid, text) is
  '终结助手一轮对话：能审计到实测用量时精确结算，审计不过则保守保持成本占用；成功时落下助手轮';
revoke execute on function public.server_finalize_copilot_turn(uuid, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.server_finalize_copilot_turn(uuid, uuid, text, uuid, text) to service_role;
