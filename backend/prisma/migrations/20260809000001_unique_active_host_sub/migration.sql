-- Prevent a host user from having two simultaneously active subscriptions.
-- A host subscription covers both Morning (forwardTime) and Evening (returnTime).
-- One active subscription per user enforces the business rule:
--   ONE HOST USER → ONE ACTIVE HOST SUBSCRIPTION → Morning + Evening
--
-- This provides database-level protection against the race condition where
-- concurrent payment flows create duplicate host subscriptions before the
-- in-memory expiry logic can run.
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_host_sub_per_user
  ON subscriptions ("userId")
  WHERE role = 'host' AND status = 'ACTIVE';
