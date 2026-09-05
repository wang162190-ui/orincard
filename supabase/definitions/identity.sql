create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_type
    where typnamespace = 'public'::regnamespace
      and typname = 'account_status'
  ) then
    create type public.account_status as enum ('active', 'deleting', 'deleted');
  end if;
end
$$;

comment on type public.account_status is '账户访问与删除流程状态';

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete restrict,
  display_name text,
  preferences jsonb not null default '{}'::jsonb,
  status public.account_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is '用户公开工作区配置与账户访问状态';
comment on column public.profiles.id is '用户唯一标识，与认证主体一致';
comment on column public.profiles.display_name is '用户显示名称';
comment on column public.profiles.preferences is '默认语言、语气、页数和生成指令，不含权益';
comment on column public.profiles.status is '账户访问及删除流程状态';
comment on column public.profiles.created_at is '创建时间（UTC）';
comment on column public.profiles.updated_at is '最近修改时间（UTC）';

create or replace function private.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

comment on function private.create_profile_for_auth_user() is '为新认证主体建立最小工作区资料';
revoke execute on function private.create_profile_for_auth_user() from public, anon, authenticated;

drop trigger if exists create_profile_after_auth_user on auth.users;
create trigger create_profile_after_auth_user
after insert on auth.users
for each row execute function private.create_profile_for_auth_user();

create or replace function private.set_profile_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function private.set_profile_updated_at() is '在资料修改时记录最近修改时间';
revoke execute on function private.set_profile_updated_at() from public, anon, authenticated;

drop trigger if exists set_profile_updated_at on public.profiles;
create trigger set_profile_updated_at
before update on public.profiles
for each row execute function private.set_profile_updated_at();

alter table public.profiles enable row level security;

revoke all on table public.profiles from anon, authenticated, service_role;
grant select on table public.profiles to authenticated;
grant update (display_name, preferences) on table public.profiles to authenticated;
grant select, update on table public.profiles to service_role;

drop policy if exists profiles_select_own_active on public.profiles;
create policy profiles_select_own_active
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id and status = 'active');

drop policy if exists profiles_update_own_active on public.profiles;
create policy profiles_update_own_active
on public.profiles
for update
to authenticated
using ((select auth.uid()) = id and status = 'active')
with check ((select auth.uid()) = id and status = 'active');
