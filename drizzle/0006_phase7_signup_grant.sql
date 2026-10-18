-- Phase 7: signup credit grant.
--
-- A 'grant' is spendable credit that behaves exactly like plan allowance:
--   available = monthly_allowance_credits + SUM(grant) - used - pending
-- It is a ledger row (append-only, auditable) rather than a mutable balance
-- column, so every credit's origin is provable. Written once per signup.
ALTER TABLE "usage_ledger" DROP CONSTRAINT IF EXISTS "usage_ledger_type_check";
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_type_check"
  CHECK ("type" IN ('reservation','charge','release','overage_charge','grant'));
