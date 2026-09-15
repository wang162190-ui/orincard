-- 工具任务的终结入口。
--
-- 两个工具 worker（src/trigger/tool.ts 与 src/trigger/visual-tool.ts）此前都用裸
-- `update public.jobs set state = 'succeeded'` 收尾，从不经过任何结算函数。在
-- `/api/v1/tools/[tool]` 绕开 `server_submit_job` 的那段时间里这看不出问题——那条路径
-- 压根没有预留可释放。把提交改回 `server_submit_job` 之后问题立刻变成真的：
-- `usage_accounts.reserved` 只增不减，`granted - reserved - consumed` 一路归零，
-- 免费额度 10 个单位的用户跑满 10 次工具就被永久锁死，而 `consumed` 仍然是 0。
--
-- 这里复用 generation 走的同一个保守原语 `private.b04_finish_job_with_unknown_cost`：
-- 用户额度当场结清（成功记 consumed，失败/取消记 release），成本预留收成 `unknown`
-- 交给对账巡检真值化。工具与 generation 因此拿到逐字相同的记账口径。
create or replace function public.server_finalize_tool_job(
  p_job_id uuid,
  p_owner_id uuid,
  p_result_ref jsonb,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare target public.jobs;
begin
  select * into target from public.jobs
  where id = p_job_id and owner_id = p_owner_id and kind = 'tool' for update;
  if target.id is null then return false; end if;
  -- 重复收尾是正常结果（Trigger 重试）：如实回报既有终态，不再动账。
  if target.state in ('succeeded', 'partial', 'failed', 'canceled') then
    return target.state = 'succeeded';
  end if;
  if (p_result_ref is null) = (p_error_code is null) then
    raise exception using errcode = '22023', message = 'exactly one tool result is required';
  end if;
  -- 未派发/排队态也收在这里：claim 阶段的 CONTEXT_UNAVAILABLE 同样必须释放预留。
  perform private.b04_finish_job_with_unknown_cost(
    p_job_id, p_error_code is null, p_result_ref, p_error_code
  );
  return p_error_code is null and target.cancel_requested_at is null;
end;
$$;

comment on function public.server_finalize_tool_job(uuid, uuid, jsonb, text)
is '工具任务终结的受限入口：结清用户额度并保守保留成本预留待对账';
revoke execute on function public.server_finalize_tool_job(uuid, uuid, jsonb, text)
from public, anon, authenticated;
grant execute on function public.server_finalize_tool_job(uuid, uuid, jsonb, text)
to service_role;
