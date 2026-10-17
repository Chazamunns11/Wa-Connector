-- Warm-up for newly linked numbers (services/whatsapp-bridge/src/pacing.ts,
-- WARMUP_SCHEDULE; only read when WA_WARMUP_ENABLED is set on the bridge).
--
-- When the CURRENT phone_number was first linked on this tenant. The bridge
-- keeps it while the same number reconnects, stamps now() when a different
-- number links, and clears it in wipeCreds (logout, ban, unlink), so a
-- number linked again later starts its warm-up again. NULL = not known yet;
-- the bridge treats that as "linked now" the next time the number connects.
alter table public.whatsapp_sessions
  add column phone_linked_at timestamptz;
