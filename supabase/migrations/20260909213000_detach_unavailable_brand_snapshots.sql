create or replace function private.sync_project_brand_kit_id()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  requested_brand_id text;
begin
  requested_brand_id := nullif(new.document #>> '{brandSnapshot,kitId}', '');
  new.brand_kit_id := null;
  if requested_brand_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    select id into new.brand_kit_id from public.brand_kits
    where id = requested_brand_id::uuid and owner_id = new.owner_id and state = 'active';
  end if;
  return new;
end;
$$;

comment on function private.sync_project_brand_kit_id() is '从 CarouselDocument 品牌快照同步同所有者活跃品牌引用，不可用品牌仅保留文档快照';
