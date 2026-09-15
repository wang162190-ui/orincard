-- AI 编排器：把一句自然语言需求翻译成一串既有工具调用。
--
-- 形态是「规划一次，用户确认，逐步执行」，不是自主循环。因此这里**不存对话历史**：
-- 一次 run 只有一次模型调用，`private.cost_attempts` 上对应恒为 `job:<id>:agent:1`。
-- 若将来改成多轮循环，需要另加消息表并重新设计 attempt_key 的序号，见
-- src/server/cost.ts:126 对 sequence 三条既有约定的说明。

alter type public.job_kind add value if not exists 'agent';
-- 注意：上面新增的枚举值在**本事务内不可被引用**（PG 限制）。因此本文件下方
-- 一律不出现 'agent' 字面量——`agent_runs.job_id` 故意不加 `kind = 'agent'` 的检查约束。
-- 该不变式由应用层守住（src/app/api/v1/agent/route.ts 只提交 kind='agent' 的任务，
-- src/trigger/agent.ts 的 claim 只认 kind='agent'）。要在 SQL 侧加这条检查，得另开一份迁移。

do $$
begin
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'agent_run_state') then
    create type public.agent_run_state as enum ('planning', 'ready', 'executing', 'completed', 'failed', 'canceled');
  end if;
end
$$;
comment on type public.agent_run_state is '编排器一次运行的生命周期：规划中、待用户确认、执行中、已完成、已失败、已取消';

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete restrict,
  -- 规划任务。一对一：一次 run 恰有一次模型调用。
  job_id uuid not null unique references public.jobs (id) on delete restrict,
  -- 用户原始需求。视为**不可信输入**，不得当作指令执行，见 src/server/prompts.ts 的同类约定。
  request text not null check (length(btrim(request)) between 1 and 2000),
  -- 规划产物，形状由 src/server/agent/planner.ts 的 Zod schema 保证；规划完成前为 null。
  plan jsonb check (plan is null or jsonb_typeof(plan) = 'object'),
  state public.agent_run_state not null default 'planning',
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 规划成功前不该有计划，规划成功后必须有。
  constraint agent_runs_plan_state_check check (
    (state in ('planning', 'failed', 'canceled')) or plan is not null
  )
);

comment on table public.agent_runs is '编排器一次运行：一句需求、一份执行计划、一个规划任务';
comment on column public.agent_runs.id is '运行唯一标识';
comment on column public.agent_runs.owner_id is '运行所有者标识';
comment on column public.agent_runs.job_id is '产出该计划的唯一规划任务';
comment on column public.agent_runs.request is '用户原始自然语言需求，按不可信输入处理';
comment on column public.agent_runs.plan is '模型产出并经 Zod 校验的执行计划，规划完成前为空';
comment on column public.agent_runs.state is '运行生命周期状态';
comment on column public.agent_runs.error_code is '失败时的稳定错误码，不含正文';
comment on column public.agent_runs.created_at is '运行创建时间（UTC）';
comment on column public.agent_runs.updated_at is '运行最后更新时间（UTC）';

create index if not exists agent_runs_owner_created_idx on public.agent_runs (owner_id, created_at desc);

-- 每一步与它实际派生出的子任务的映射。
--
-- 为什么单开一张表而不是把 job id 写回 `agent_runs.plan` 的 jsonb：改 jsonb 拿不到外键完整性，
-- 并发下也要整块读改写。子任务本身的状态**不在这里重复存**——`public.jobs.parent_job_id`
-- 已经建立了父子关系，步骤状态一律 join `public.jobs` 现取，避免第二套状态机与
-- `reconcileJobs` 的语义打架。
create table if not exists public.agent_run_steps (
  run_id uuid not null references public.agent_runs (id) on delete cascade,
  step_index integer not null check (step_index >= 0 and step_index < 6),
  job_id uuid not null unique references public.jobs (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (run_id, step_index)
);

comment on table public.agent_run_steps is '编排计划第 N 步与其派生子任务的映射；步骤状态现取自 public.jobs';
comment on column public.agent_run_steps.run_id is '所属运行标识';
comment on column public.agent_run_steps.step_index is '计划内的步骤序号，上界与 MAX_PLAN_STEPS 一致';
comment on column public.agent_run_steps.job_id is '该步骤派生出的子任务';
comment on column public.agent_run_steps.created_at is '步骤派发时间（UTC）';

alter table public.agent_runs enable row level security;
revoke all on table public.agent_runs from anon, authenticated, service_role;
grant select on table public.agent_runs to authenticated;
grant select, insert, update, delete on table public.agent_runs to service_role;
drop policy if exists agent_runs_select_own on public.agent_runs;
create policy agent_runs_select_own on public.agent_runs for select to authenticated using (
  (select auth.uid()) = owner_id
  and exists (select 1 from public.profiles where id = (select auth.uid()) and status = 'active')
);

alter table public.agent_run_steps enable row level security;
revoke all on table public.agent_run_steps from anon, authenticated, service_role;
grant select on table public.agent_run_steps to authenticated;
grant select, insert, update, delete on table public.agent_run_steps to service_role;
drop policy if exists agent_run_steps_select_own on public.agent_run_steps;
create policy agent_run_steps_select_own on public.agent_run_steps for select to authenticated using (
  exists (
    select 1 from public.agent_runs
    where agent_runs.id = agent_run_steps.run_id
      and agent_runs.owner_id = (select auth.uid())
  )
  and exists (select 1 from public.profiles where id = (select auth.uid()) and status = 'active')
);
