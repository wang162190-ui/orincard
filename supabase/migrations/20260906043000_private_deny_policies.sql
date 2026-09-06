-- Private tables have no client grants or schema usage. Explicit deny policies
-- keep that boundary visible to database security auditing as well.

drop policy if exists cost_budgets_no_direct_access on private.cost_budgets;
create policy cost_budgets_no_direct_access on private.cost_budgets
for all to public using (false) with check (false);

drop policy if exists cost_reservations_no_direct_access on private.cost_reservations;
create policy cost_reservations_no_direct_access on private.cost_reservations
for all to public using (false) with check (false);

drop policy if exists cost_attempts_no_direct_access on private.cost_attempts;
create policy cost_attempts_no_direct_access on private.cost_attempts
for all to public using (false) with check (false);

drop policy if exists operation_receipts_no_direct_access on private.operation_receipts;
create policy operation_receipts_no_direct_access on private.operation_receipts
for all to public using (false) with check (false);

drop policy if exists request_guards_no_direct_access on private.request_guards;
create policy request_guards_no_direct_access on private.request_guards
for all to public using (false) with check (false);
