-- 20261027070000_email_type_purchase_order.sql
-- To-Do 0.15 (2026-10-26): a copy of a purchase order can be emailed as a PDF to
-- the company ordering address (never to a vendor; Mason places orders through
-- each supplier's portal).
-- ---------------------------------------------------------------------------
-- The send-email edge function writes every send to public.email_log, whose
-- email_type column is the public.email_type ENUM. A purchase-order copy send
-- needs its own value so the audit log classifies it honestly (customer_id stays
-- NULL on these rows; the column is already nullable).
--
-- ADDITIVE ONLY: one new enum value. No table, row, function, grant or policy is
-- touched. ALTER TYPE ... ADD VALUE must not be used by another object in the
-- same transaction; nothing here references it, and IF NOT EXISTS makes the
-- migration safe to re-run. Its only consumer is the send-email edge function
-- (allow-listed for admins), which is deployed separately with Mason's approval.

ALTER TYPE public.email_type ADD VALUE IF NOT EXISTS 'purchase_order';
