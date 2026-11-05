-- P6 STEP B (roadmap 3, P6): a valid check is in force for 37 hours instead
-- of 30, so new registrations stop 36 hours after it was read and existing
-- push sending 37 hours after it.
--
-- Only private.p6_check_expires_at changes, from checked_at + 30 hours to
-- checked_at + 37 hours, with the same signature, return value, owner,
-- SECURITY INVOKER, IMMUTABLE, empty search_path and privileges (none for
-- clients). private.p6_check_deadline still returns that time minus 1 hour,
-- so registrations and token-change confirmations stop at 36 hours and
-- sending may go on only in the grace hour up to 37 hours. 37 hours is an
-- absolute bound: the 1-hour grace of a monitoring failure is still capped
-- by it (least(...)), never added after it. Anything that stops earlier
-- still wins: the billing-period boundary (P1), 90% / 95%, a manual stop, a
-- monitoring failure. Thresholds, resume rules, data_as_of checks (STEP A)
-- and the two push intake gates (still false) are unchanged.
--
-- Initial deployments only (D1). The P6 state is worked out from the stored
-- history every time, so a longer expiry would also apply to past checks: a
-- target that already stopped at 30 hours could reopen without an admin
-- resume. This migration therefore changes the function only while P6 has
-- no history at all: the control row as created (version 1, never resumed)
-- and the seven history tables empty. Otherwise it raises 55000 and changes
-- nothing.
--
-- Everything runs in one DO statement, so it is atomic whether or not the
-- migration runner wraps the file in a transaction. It takes the same
-- control-row lock every P6 write RPC takes first, so no P6 write can
-- commit between the check and the change; it waits at most 5 seconds for
-- that lock (lock_timeout, local to this transaction, restored afterwards).
-- Direct SQL that bypasses the P6 RPCs and their lock is not covered.

do $migration$
declare
  v_lock_timeout text := pg_catalog.current_setting('lock_timeout');
begin
  perform pg_catalog.set_config('lock_timeout', '5s', true);

  -- The lock every P6 write RPC takes first.
  perform 1 from private.p6_control c where c.id = 1 for update;

  if (select pg_catalog.count(*) from private.p6_control) <> 1
    or not exists (
      select 1 from private.p6_control c
      where c.id = 1
        and c.version = 1
        and c.registration_resumed_at is null
        and c.send_resumed_at is null)
    or exists (select 1 from private.p6_usage_checks)
    or exists (select 1 from private.p6_usage_values)
    or exists (select 1 from private.p6_check_voids)
    or exists (select 1 from private.p6_monitoring_failures)
    or exists (select 1 from private.p6_manual_stops)
    or exists (select 1 from private.p6_admin_events)
    or exists (select 1 from private.p6_warnings)
  then
    raise exception 'P6 STEP B applies only to an initial P6 deployment (P6 history exists)'
      using errcode = '55000';
  end if;

  execute $ddl$
    create or replace function private.p6_check_expires_at(p_checked_at timestamptz, p_period_end date)
    returns timestamptz
    language sql
    immutable
    set search_path = ''
    as $fn$ select least(p_checked_at + interval '37 hours', private.p6_period_earliest(p_period_end)) $fn$
  $ddl$;

  execute $ddl$
    revoke all on function private.p6_check_expires_at(timestamptz, date)
      from public, anon, authenticated, service_role
  $ddl$;

  perform pg_catalog.set_config('lock_timeout', v_lock_timeout, true);
end;
$migration$;
