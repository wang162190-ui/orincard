-- 额度发放：把权益策略落成 public.usage_accounts 里的额度桶。
--
-- 为什么需要这份迁移：在它之前，**没有任何生产代码路径**往 public.usage_accounts 写过一行。
-- 唯一的写入点是 supabase/tests/*.sql 和 tests/cloud/*.test.ts 的夹具。而 private.submit_job
-- （supabase/definitions/jobs-usage.sql:271）在找不到当期额度桶时会抛 22003
-- 'insufficient usage balance'。于是任何真实注册用户提交任何任务都必然失败——生成链路亦然。
--
-- 两个刻意的设计选择：
--
-- 1. **额度数字是入参，不写死在 SQL 里。** 权益策略住在 BILLING_POLICY_JSON（见
--    src/server/billing/policy.ts），数据库对「方案」这个概念一无所知，也不该知道。
--    在这里写死一个 free 方案的数字，等于把同一份策略复制到第二处，两处一定会漂移。
--
-- 2. **按周期发放，不是按注册发放。** usage_accounts 的唯一键是
--    (owner_id, period_start, resource)，额度桶天然是按周期切的。挂在 profile 创建上的
--    触发器只能发出第一个月的桶，下个月同一个 22003 会原样回来。所以入口是
--    「确保当前周期的桶存在」，由提交路径在每次提交前调用。

create or replace function private.grant_usage_account(
  p_owner_id uuid,
  p_resource text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_granted bigint
)
returns public.usage_accounts
language plpgsql
security definer
set search_path = ''
as $$
declare granted_account public.usage_accounts;
begin
  if p_granted < 0 then
    raise exception using errcode = '22003', message = 'granted units must not be negative';
  end if;
  if p_period_end <= p_period_start then
    raise exception using errcode = '22023', message = 'period end must follow period start';
  end if;

  -- 冲突时取 greatest 而不是直接覆盖：调高 granted 永远安全，调低则可能打破
  -- usage_accounts_balance_check（reserved + consumed <= granted）——比如用户本周期已经用掉 8 次，
  -- 此时把 granted 从 10 改成 5 会直接让约束失败。降级只能等下一个周期的新桶生效。
  insert into public.usage_accounts (owner_id, period_start, period_end, resource, granted)
  values (p_owner_id, p_period_start, p_period_end, p_resource, p_granted)
  on conflict (owner_id, period_start, resource) do update
  set granted = greatest(public.usage_accounts.granted, excluded.granted),
      updated_at = now()
  returning * into granted_account;

  return granted_account;
end;
$$;

comment on function private.grant_usage_account(uuid, text, timestamptz, timestamptz, bigint)
is '幂等确保某所有者在指定周期内持有某资源的额度桶，额度只升不降';
revoke execute on function private.grant_usage_account(uuid, text, timestamptz, timestamptz, bigint)
from public, anon, authenticated;
grant execute on function private.grant_usage_account(uuid, text, timestamptz, timestamptz, bigint)
to service_role;

create or replace function public.server_grant_usage_account(
  p_owner_id uuid,
  p_resource text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_granted bigint
)
returns public.usage_accounts
language sql
set search_path = ''
as $$
  select private.grant_usage_account(
    p_owner_id,
    p_resource,
    p_period_start,
    p_period_end,
    p_granted
  );
$$;

comment on function public.server_grant_usage_account(uuid, text, timestamptz, timestamptz, bigint)
is '服务端经 Data API 按权益策略发放周期额度的受限入口';
revoke execute on function public.server_grant_usage_account(uuid, text, timestamptz, timestamptz, bigint)
from public, anon, authenticated;
grant execute on function public.server_grant_usage_account(uuid, text, timestamptz, timestamptz, bigint)
to service_role;
