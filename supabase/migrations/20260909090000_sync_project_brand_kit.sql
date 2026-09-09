create or replace function private.sync_project_brand_kit_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.brand_kit_id := nullif(new.document #>> '{brandSnapshot,kitId}', '')::uuid;
  return new;
end;
$$;

comment on function private.sync_project_brand_kit_id() is '从 CarouselDocument 品牌快照同步项目品牌引用，供影响检查和引用约束使用';

drop trigger if exists projects_sync_brand_kit_id on public.projects;
create trigger projects_sync_brand_kit_id
before insert or update of document on public.projects
for each row execute function private.sync_project_brand_kit_id();

comment on trigger projects_sync_brand_kit_id on public.projects is '项目文档写入时同步 brand_kit_id';

update public.projects as project
set brand_kit_id = brand.id
from public.brand_kits as brand
where brand.id = nullif(project.document #>> '{brandSnapshot,kitId}', '')::uuid
  and brand.owner_id = project.owner_id
  and project.brand_kit_id is distinct from brand.id;
