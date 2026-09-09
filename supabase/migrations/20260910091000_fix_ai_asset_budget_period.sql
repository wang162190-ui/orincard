alter table private.ai_asset_reservations
  drop constraint if exists ai_asset_reservations_period_check;
alter table private.ai_asset_reservations
  add constraint ai_asset_reservations_period_check
  check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

comment on constraint ai_asset_reservations_period_check on private.ai_asset_reservations
is '限制成本预算周期为 YYYY-MM 格式';
