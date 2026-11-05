-- pgTAP tests for P6 STEP B: a valid check is in force for 37 hours from
-- checked_at, so new registrations (and token-change confirmations) stop at
-- 36 hours and sending at 37 hours. 37 hours is an absolute bound (a
-- monitoring failure's grace never goes past it) and anything that stops
-- earlier still wins. One transaction, rolled back; the P6 clock is replaced
-- for this transaction only. Times are UTC.
--
-- The initial-deployment guard of the migration (it refuses to run once P6
-- has any history) is tested separately, by running the migration itself
-- against isolated databases; it cannot be re-run from inside this test.

begin;

create extension if not exists pgtap with schema extensions;

select plan(85);

-- ============================================================
-- The function: shape, owner and privileges
-- ============================================================

select ok((select strpos(prosrc, '''37 hours''') > 0 from pg_proc where oid = 'private.p6_check_expires_at(timestamptz, date)'::regprocedure), 'expiry is checked_at + 37 hours');
select ok((select strpos(prosrc, '''30 hours''') = 0 from pg_proc where oid = 'private.p6_check_expires_at(timestamptz, date)'::regprocedure), 'the 30-hour expiry is gone');
select is((select prosecdef from pg_proc where oid = 'private.p6_check_expires_at(timestamptz, date)'::regprocedure), false, 'still SECURITY INVOKER');
select is((select provolatile::text from pg_proc where oid = 'private.p6_check_expires_at(timestamptz, date)'::regprocedure), 'i', 'still IMMUTABLE');
select is((select proconfig from pg_proc where oid = 'private.p6_check_expires_at(timestamptz, date)'::regprocedure), array['search_path=""'], 'still an empty search_path');
select is((select prorettype::regtype::text from pg_proc where oid = 'private.p6_check_expires_at(timestamptz, date)'::regprocedure), 'timestamp with time zone', 'still returns timestamptz');
select is((select count(*)::int from pg_proc where proname = 'p6_check_expires_at'), 1, 'no other version of the function');
select is(
  (select proowner from pg_proc where oid = 'private.p6_check_expires_at(timestamptz, date)'::regprocedure),
  (select proowner from pg_proc where oid = 'private.p6_check_deadline(timestamptz, date)'::regprocedure),
  'same owner as the other P6 helpers');
select ok((select strpos(prosrc, 'p6_check_expires_at(p_checked_at, p_period_end) - interval ''1 hour''') > 0 from pg_proc where oid = 'private.p6_check_deadline(timestamptz, date)'::regprocedure), 'the registration deadline is still the expiry minus 1 hour');
select ok(not has_function_privilege('anon', 'private.p6_check_expires_at(timestamptz, date)', 'execute'), 'anon cannot execute it');
select ok(not has_function_privilege('authenticated', 'private.p6_check_expires_at(timestamptz, date)', 'execute'), 'authenticated cannot execute it');
select ok(not has_function_privilege('service_role', 'private.p6_check_expires_at(timestamptz, date)', 'execute'), 'service_role cannot execute it');
select ok(exists (select 1 from supabase_migrations.schema_migrations where version = '20261105090000'), 'the STEP B migration is recorded');
select ok(not private.push_registration_intake_open() and not private.push_token_change_open(), 'both gates are closed');

-- ============================================================
-- Expiry helpers: 37 / 36 hours, the billing-period end (P1) when sooner
-- ============================================================

select is(private.p6_check_expires_at('2026-11-06 00:00+00', '2026-12-02'), '2026-11-07 13:00+00'::timestamptz, 'mid-period: in force until checked_at + 37 hours');
select is(private.p6_check_deadline('2026-11-06 00:00+00', '2026-12-02'), '2026-11-07 12:00+00'::timestamptz, 'registrations stop at checked_at + 36 hours');
-- The period ending Dec 2 can end as early as Dec 1 10:00 UTC.
select is(private.p6_check_expires_at('2026-11-29 21:00+00', '2026-12-02'), '2026-12-01 10:00+00'::timestamptz, 'P1: 37 hours ending exactly at the earliest period end');
select is(private.p6_check_expires_at('2026-11-29 20:59:59.999999+00', '2026-12-02'), '2026-12-01 09:59:59.999999+00'::timestamptz, 'P1: 1 us earlier, the 37 hours end first');
select is(private.p6_check_expires_at('2026-11-29 21:00:00.000001+00', '2026-12-02'), '2026-12-01 10:00+00'::timestamptz, 'P1: 1 us later, the earliest period end wins');
select is(private.p6_check_deadline('2026-11-29 21:00:00.000001+00', '2026-12-02'), '2026-12-01 09:00+00'::timestamptz, 'P1: registrations stop 1 hour before the period end');
-- 37 real hours whatever the session time zone, also across a DST change
-- (New York leaves daylight time on Nov 1 2026).
set local timezone to 'America/New_York';
select is(extract(epoch from private.p6_check_expires_at('2026-10-31 12:00-04', '2026-12-02') - '2026-10-31 12:00-04'::timestamptz)::int, 133200, 'New York session, across the DST change: exactly 37 hours');
set local timezone to 'Asia/Tokyo';
select is(extract(epoch from private.p6_check_expires_at('2026-11-06 09:00+09', '2026-12-02') - '2026-11-06 09:00+09'::timestamptz)::int, 133200, 'Tokyo session: exactly 37 hours');
set local timezone to 'UTC';

-- ============================================================
-- Fixtures and helpers (as in p6_usage_monitoring_test.sql)
-- ============================================================

insert into auth.users (id, email, aud, role)
values
  ('00000000-0000-4000-8000-0000000063a1', 'p6-stepb-admin@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000063b1', 'p6-stepb-user@example.invalid', 'authenticated', 'authenticated');
insert into public.admin_users (user_id) values ('00000000-0000-4000-8000-0000000063a1');

create or replace function private.p6_current_time()
returns timestamptz language sql volatile set search_path = ''
as $$ select pg_catalog.current_setting('p6test.now')::timestamptz $$;

-- All eleven metrics measured; byte metrics 0 GB, counts 0, disks 2 GB.
create function pg_temp.vals(p jsonb default '{}'::jsonb) returns jsonb language sql immutable as $$
  select jsonb_agg(coalesce(p -> m.code, jsonb_build_object('metric', m.code, 'status', 'measured', 'value', m.v, 'unit', m.u, 'quota', m.q)) order by m.n)
  from (values
    (1, 'egress', '0', 'GB', '250'),
    (2, 'cached_egress', '0', 'GB', '250'),
    (3, 'edge_function_invocations', '0', 'count', '2000000'),
    (4, 'monthly_active_users', '0', 'count', '100000'),
    (5, 'storage_size', '0', 'GB', '100'),
    (6, 'realtime_messages', '0', 'count', '5000000'),
    (7, 'realtime_peak_connections', '0', 'count', '500'),
    (8, 'log_ingestion', '0', 'GB', '20'),
    (9, 'log_query', '0', 'GB', '2000'),
    (10, 'disk_size_preview', '2', 'GB', '8'),
    (11, 'disk_size_production', '2', 'GB', '8')) m(n, code, v, u, q)
$$;

create function pg_temp.one(p_metric text, p_entry jsonb) returns jsonb language sql immutable as $$
  select pg_temp.vals(jsonb_build_object(p_metric, jsonb_build_object('metric', p_metric) || p_entry))
$$;

create function pg_temp.pre(
  p_now timestamptz, p_checked timestamptz, p_values jsonb default null, p_asof timestamptz default null
) returns jsonb language plpgsql as $$
begin
  perform set_config('p6test.now', p_now::text, true);
  return public.admin_record_p6_usage_check(p_checked, '2026-11-02', '2026-12-02', 'on', p_asof, coalesce(p_values, pg_temp.vals()), false, null, null);
end;
$$;

create function pg_temp.rec(
  p_now timestamptz, p_checked timestamptz, p_values jsonb default null, p_asof timestamptz default null
) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  v := pg_temp.pre(p_now, p_checked, p_values, p_asof);
  return public.admin_record_p6_usage_check(p_checked, '2026-11-02', '2026-12-02', 'on', p_asof, coalesce(p_values, pg_temp.vals()), true, (v ->> 'version')::bigint, (v ->> 'valid')::boolean);
end;
$$;

create function pg_temp.reasons(v jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(e, ',' order by o), '') from jsonb_array_elements_text(v -> 'reasons') with ordinality t(e, o)
$$;

create function pg_temp.at(p_now timestamptz) returns jsonb language plpgsql as $$
begin
  perform set_config('p6test.now', p_now::text, true);
  return public.admin_get_p6_status();
end;
$$;

create function pg_temp.flags(p_now timestamptz) returns text language plpgsql as $$
declare
  s jsonb := pg_temp.at(p_now) -> 'state';
begin
  return format('reg=%s tc=%s send=%s grace=%s',
    (s ->> 'registration_allowed')::boolean::int, (s ->> 'token_change_allowed')::boolean::int,
    (s ->> 'sends_allowed')::boolean::int, (s ->> 'send_in_grace')::boolean::int);
end;
$$;

create function pg_temp.resume(p_now timestamptz, p_target text) returns text language plpgsql as $$
declare
  v jsonb;
begin
  v := public.admin_resume_p6(p_target, (pg_temp.at(p_now) -> 'state' ->> 'version')::bigint);
  return coalesce(v ->> 'reason', 'ok');
end;
$$;

create function pg_temp.fail(p_now timestamptz) returns uuid language plpgsql as $$
begin
  perform set_config('p6test.now', p_now::text, true);
  return public.admin_record_p6_monitoring_failure('dashboard_unavailable');
end;
$$;

create function pg_temp.stop(p_now timestamptz) returns uuid language plpgsql as $$
begin
  perform set_config('p6test.now', p_now::text, true);
  return public.admin_stop_p6('usage_concern');
end;
$$;

-- ============================================================
-- Denied callers
-- ============================================================

select set_config('p6test.now', '2026-11-05 00:00+00', true);

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok($$select private.p6_check_expires_at(now(), current_date)$$, '42501', null, 'anon: expiry helper not callable');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000063b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select private.p6_check_expires_at(now(), current_date)$$, '42501', null, 'non-admin: expiry helper not callable');
select throws_ok($$select public.admin_get_p6_status()$$, '42501', 'insufficient privilege', 'non-admin: status denied');
select throws_ok($$select count(*) from private.p6_control$$, '42501', null, 'non-admin: private table not readable');
reset role;

-- ============================================================
-- Start: two checks 24 hours apart, explicit resume
-- ============================================================

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000063a1","role":"authenticated"}', true);
set local role authenticated;

select is((pg_temp.rec('2026-11-05 00:05+00', '2026-11-05 00:00+00') ->> 'valid')::boolean, true, 'c1 (Nov 5 00:00) valid');
select is((pg_temp.rec('2026-11-06 00:05+00', '2026-11-06 00:00+00') ->> 'valid')::boolean, true, 'c2 (Nov 6 00:00) valid');
select is(pg_temp.resume('2026-11-06 00:10+00', 'send'), 'ok', 'sending resumed');
select is(pg_temp.resume('2026-11-06 00:10+00', 'registration'), 'ok', 'registrations resumed');

-- A check recorded before c2's 36-hour deadline continues it.
select is((pg_temp.rec('2026-11-07 11:59+00', '2026-11-07 11:55+00') ->> 'valid')::boolean, true, 'c3 (Nov 7 11:55) recorded 35 h 59 min after c2 was read');
select is(pg_temp.flags('2026-11-07 12:00+00'), 'reg=1 tc=1 send=1 grace=0', 'c2 + 36 h: c3 keeps everything open');
select is(pg_temp.flags('2026-11-07 13:00+00'), 'reg=1 tc=1 send=1 grace=0', 'c2 + 37 h: c3 keeps everything open');
select is((pg_temp.at('2026-11-07 12:00+00') -> 'state' ->> 'current_check_registration_deadline')::timestamptz, '2026-11-08 23:55+00'::timestamptz, 'registration deadline: c3 read + 36 hours');
select is((pg_temp.at('2026-11-07 12:00+00') -> 'state' ->> 'current_check_send_deadline')::timestamptz, '2026-11-09 00:55+00'::timestamptz, 'send deadline: c3 read + 37 hours');

-- ============================================================
-- 36 hours: registrations and token changes stop
-- ============================================================

select is(pg_temp.flags('2026-11-08 23:54:59.999999+00'), 'reg=1 tc=1 send=1 grace=0', '36 h minus 1 us: everything allowed');
select is(pg_temp.flags('2026-11-08 23:55+00'), 'reg=0 tc=0 send=1 grace=1', '36 h exactly: registrations and token changes stop, sending in grace');
select is(pg_temp.at('2026-11-08 23:55+00') -> 'state' ->> 'registration_stop_reason', 'expired', 'registration reason: expired');
select is(pg_temp.flags('2026-11-08 23:55:00.000001+00'), 'reg=0 tc=0 send=1 grace=1', '36 h plus 1 us: still stopped, sending in grace');

-- ============================================================
-- 37 hours: sending stops (an absolute bound)
-- ============================================================

select is(pg_temp.flags('2026-11-09 00:54:59.999999+00'), 'reg=0 tc=0 send=1 grace=1', '37 h minus 1 us: sending still in grace');
select is(pg_temp.flags('2026-11-09 00:55+00'), 'reg=0 tc=0 send=0 grace=0', '37 h exactly: sending stops');
select is(pg_temp.flags('2026-11-09 00:55:00.000001+00'), 'reg=0 tc=0 send=0 grace=0', '37 h plus 1 us: sending stopped');
select is((pg_temp.at('2026-11-09 00:55+00') -> 'state' ->> 'send_stop_at')::timestamptz, '2026-11-09 00:55+00'::timestamptz, 'send stop time: c3 read + 37 hours');
select is(pg_temp.at('2026-11-09 00:55+00') -> 'state' ->> 'send_stop_reason', 'expired', 'send reason: expired');

-- A failure during the last hour gets no hour of its own past 37 hours, and
-- a valid check in that hour extends nothing.
select isnt(pg_temp.fail('2026-11-09 00:25+00'), null, 'failure at c3 + 36 h 30 min');
select is((pg_temp.at('2026-11-09 00:30+00') -> 'state' ->> 'send_grace_until')::timestamptz, '2026-11-09 00:55+00'::timestamptz, 'grace ends at 37 h, not at the failure + 1 hour');
select is((pg_temp.rec('2026-11-09 00:40+00', '2026-11-09 00:35+00') ->> 'valid')::boolean, true, 'c4 (Nov 9 00:35, in the last hour) valid');
select is(pg_temp.flags('2026-11-09 00:54:59.999999+00'), 'reg=0 tc=0 send=1 grace=1', 'c4 reopens nothing');
select is(pg_temp.flags('2026-11-09 00:55+00'), 'reg=0 tc=0 send=0 grace=0', 'neither the failure nor c4 moves the 37-hour stop');
select is(pg_temp.flags('2026-11-09 01:24:59.999999+00'), 'reg=0 tc=0 send=0 grace=0', 'no sending in the hour after 37 h (no 38 h)');
select is(pg_temp.flags('2026-11-09 01:54:59.999999+00'), 'reg=0 tc=0 send=0 grace=0', 'still stopped later on');

-- ============================================================
-- Recovery: continuity, check_expired and gaps use 36 hours
-- ============================================================

select is((pg_temp.rec('2026-11-09 01:05+00', '2026-11-09 01:00+00') ->> 'valid')::boolean, true, 'c5 (Nov 9 01:00) valid, after the stop');
select is((pg_temp.rec('2026-11-10 12:59+00', '2026-11-10 12:55+00') ->> 'valid')::boolean, true, 'c6 (Nov 10 12:55) recorded 35 h 59 min after c5 was read');
select is(pg_temp.at('2026-11-10 13:05+00') ->> 'resume_send_refusal', null, 'c5 and c6: no gap, a resume would be allowed');
select is(pg_temp.at('2026-11-12 00:54:59.999999+00') ->> 'resume_send_refusal', null, 'c6 + 36 h minus 1 us: still allowed');
select is(pg_temp.at('2026-11-12 00:55+00') ->> 'resume_send_refusal', 'check_expired', 'c6 + 36 h: check_expired');
select is((pg_temp.rec('2026-11-12 00:55+00', '2026-11-12 00:50+00') ->> 'valid')::boolean, true, 'c7 (Nov 12 00:50) recorded exactly 36 h after c6 was read');
select is(pg_temp.at('2026-11-12 01:00+00') ->> 'resume_send_refusal', 'gap_between_checks', 'c6 and c7: a gap of 36 h refuses the resume');
select is(pg_temp.flags('2026-11-12 01:00+00'), 'reg=0 tc=0 send=0 grace=0', 'nothing reopened by itself');

-- ============================================================
-- STEP A data time with the 37-hour expiry (accepted risk D2)
-- ============================================================

select is(pg_temp.reasons(pg_temp.pre('2026-11-13 00:55+00', '2026-11-13 00:50+00', null, '2026-11-12 00:50+00')), 'data_too_old', 'data time exactly 24 h before the reading: still too old');
select is((pg_temp.rec('2026-11-13 00:55+00', '2026-11-13 00:50+00', null, '2026-11-12 00:50:00.000001+00') ->> 'valid')::boolean, true, 'c8: data time 24 h minus 1 us before the reading: valid');
select is(pg_temp.resume('2026-11-13 01:00+00', 'send'), 'ok', 'c7 and c8 (24 h apart): sending resumed by the admin');
select is(pg_temp.resume('2026-11-13 01:00+00', 'registration'), 'ok', 'registrations resumed by the admin');
select is(pg_temp.flags('2026-11-13 01:00+00'), 'reg=1 tc=1 send=1 grace=0', 'everything allowed');
select is(pg_temp.flags('2026-11-14 13:49:59.999999+00'), 'reg=0 tc=0 send=1 grace=1', 'c8 + 37 h minus 1 us (data almost 61 h old): sending still in grace');
select is(pg_temp.flags('2026-11-14 13:50+00'), 'reg=0 tc=0 send=0 grace=0', 'c8 + 37 h: sending stops');

-- ============================================================
-- An unavailable metric makes an invalid check; its grace is capped at 37 h
-- ============================================================

select is(pg_temp.reasons(pg_temp.rec('2026-11-14 13:25+00', '2026-11-14 13:20+00', pg_temp.one('egress', '{"status":"unavailable"}'))), 'metric_unavailable', 'c9 (egress unavailable, at c8 + 36 h 30 min): invalid');
select is((pg_temp.at('2026-11-14 13:30+00') -> 'state' ->> 'send_grace_until')::timestamptz, '2026-11-14 13:50+00'::timestamptz, 'grace ends at c8 + 37 h, not at c9 + 1 hour');
select is(pg_temp.flags('2026-11-14 13:49:59.999999+00'), 'reg=0 tc=0 send=1 grace=1', 'just before 37 h: sending in grace');
select is(pg_temp.flags('2026-11-14 13:50+00'), 'reg=0 tc=0 send=0 grace=0', '37 h: sending stops');
select is(pg_temp.flags('2026-11-14 14:24:59.999999+00'), 'reg=0 tc=0 send=0 grace=0', 'no sending up to c9 + 1 hour');

-- ============================================================
-- Earlier stops still win inside the 37-hour window
-- ============================================================

select is((pg_temp.rec('2026-11-14 14:05+00', '2026-11-14 14:00+00') ->> 'valid')::boolean, true, 'c10 (Nov 14 14:00) valid');
select is((pg_temp.rec('2026-11-15 14:05+00', '2026-11-15 14:00+00') ->> 'valid')::boolean, true, 'c11 (Nov 15 14:00, zero values again) valid');
select is(pg_temp.resume('2026-11-15 14:10+00', 'send'), 'ok', 'sending resumed');
select is(pg_temp.resume('2026-11-15 14:10+00', 'registration'), 'ok', 'registrations resumed');
select is((pg_temp.rec('2026-11-15 15:05+00', '2026-11-15 15:00+00', pg_temp.one('egress', '{"status":"measured","value":"225","unit":"GB","quota":"250"}')) ->> 'valid')::boolean, true, 'c12: egress 90.000% valid');
select is(pg_temp.flags('2026-11-15 15:05+00'), 'reg=0 tc=1 send=1 grace=0', '90%: registrations stop at once, long before 36 h');
select is((pg_temp.rec('2026-11-15 16:05+00', '2026-11-15 16:00+00', pg_temp.one('egress', '{"status":"measured","value":"237.5","unit":"GB","quota":"250"}')) ->> 'valid')::boolean, true, 'c13: egress 95.000% valid');
select is(pg_temp.flags('2026-11-15 16:05+00'), 'reg=0 tc=0 send=0 grace=0', '95%: sending stops at once, long before 37 h');
select is(pg_temp.at('2026-11-15 16:05+00') -> 'state' ->> 'send_stop_reason', 'usage_95', 'send reason: 95%');
select isnt(pg_temp.stop('2026-11-15 16:10+00'), null, 'manual stop');
select is((pg_temp.at('2026-11-15 16:10+00') -> 'state' ->> 'manual_stop_active')::boolean, true, 'manual stop shown as active');

reset role;

-- ============================================================
-- Audit, version and gates
-- ============================================================

select is((select count(*)::int from private.p6_admin_events where action = 'record_check'), (select count(*)::int from private.p6_usage_checks), 'one record_check event per stored check');
select is((select version from private.p6_control), 1 + (select count(*) from private.p6_admin_events where action <> 'resume_refused'), 'the version moved once per write');
select ok(not private.push_registration_intake_open() and not private.push_token_change_open(), 'both gates still closed');

select * from finish();
rollback;
