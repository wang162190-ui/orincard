-- 付费通道当前不接支付，唯一的「付费路线」是等候名单。名单必须真的存下来——
-- 原来的对话框只在前端显示一句「没有提交也没有存储」，那是一个诚实但没有用的占位。

create table if not exists public.waitlist_signups (
  id uuid primary key default gen_random_uuid(),
  -- 统一小写入库并直接建唯一约束，而不是建 lower(email) 的表达式索引：
  -- PostgREST 的 on_conflict 只认列上的唯一约束，表达式索引它用不上，
  -- 重复提交就会变成 500 而不是静默折叠。
  email text not null unique,
  -- 想要哪个档位。允许为空：首页/定价页的通用入口不强制选档。
  plan_key public.billing_plan_key,
  -- 从哪个入口进来的，用来判断哪条路径真的带来了意向，不用于追踪个人。
  source text not null,
  locale text not null,
  -- 已登录用户留个关联，退出登录或账户删除后置空，名单本身不因此失效。
  owner_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint waitlist_signups_email_check check (char_length(email) between 3 and 320 and position('@' in email) > 1 and email = lower(email)),
  constraint waitlist_signups_source_check check (source in ('pricing', 'billing', 'home')),
  constraint waitlist_signups_locale_check check (locale in ('en', 'zh-Hans'))
);

comment on table public.waitlist_signups is '付费套餐等候名单登记，支付通道开通前的唯一付费意向入口';
comment on column public.waitlist_signups.id is '登记唯一标识';
comment on column public.waitlist_signups.email is '登记邮箱，按小写去重';
comment on column public.waitlist_signups.plan_key is '意向套餐档位，未选择时为空';
comment on column public.waitlist_signups.source is '登记入口：定价页、账单页或首页';
comment on column public.waitlist_signups.locale is '登记时的界面语言，开通时按此语言通知';
comment on column public.waitlist_signups.owner_id is '登记时已登录的账户，账户删除后置空';
comment on column public.waitlist_signups.created_at is '登记时间（UTC）';

-- 同一个邮箱重复提交是常态（换个入口又点了一次），靠列上的唯一约束把它折叠成一条，
-- 写入侧用 ignoreDuplicates，因此重复提交既不报错也不产生第二条记录。
create index if not exists waitlist_signups_created_idx on public.waitlist_signups (created_at desc);

-- 开 RLS 且不建任何策略：anon 与 authenticated 都读不到、写不了这张表。
-- 写入只能走服务端用 service role 的那条路由，名单里的邮箱因此不会被任何客户端读出去。
alter table public.waitlist_signups enable row level security;
