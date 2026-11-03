-- pgTAP tests for the P6 billing-period boundary (P1) (roadmap 3, P6).
-- Everything runs inside one transaction and is rolled back. The P6 clock
-- is replaced for this transaction; times below are in UTC. The billing
-- period is Nov 2 - Dec 2, then Dec 2 - Jan 2. The dashboard's time zone is
-- not known, so a period may end as early as its end date 00:00 at UTC+14
-- (Dec 1 10:00 UTC) and start as late as its start date 00:00 at UTC-12
-- (Dec 2 12:00 UTC).

begin;

create extension if not exists pgtap with schema extensions;

select plan(33);

-- ============================================================
-- Boundary helpers
-- ============================================================

select is(private.p6_period_earliest('2026-12-02'), '2026-12-01 10:00+00'::timestamptz, 'earliest possible end of a period ending Dec 2: Dec 1 10:00 UTC');
select is(private.p6_period_latest('2026-12-02'), '2026-12-02 12:00+00'::timestamptz, 'latest possible start of a period starting Dec 2: Dec 2 12:00 UTC');
select is(private.p6_check_expires_at('2026-11-29 12:00+00', '2026-12-02'), '2026-11-30 18:00+00'::timestamptz, 'mid-period: a check is in force for 30 hours');
select is(private.p6_check_expires_at('2026-12-01 05:00+00', '2026-12-02'), '2026-12-01 10:00+00'::timestamptz, 'near the end: a check is in force only until the earliest period end');
select is(private.p6_check_deadline('2026-12-01 05:00+00', '2026-12-02'), '2026-12-01 09:00+00'::timestamptz, 'near the end: registrations stop 1 hour before that');

-- ============================================================
-- Fixtures and helpers (as in p6_usage_monitoring_test.sql)
-- ============================================================

insert into auth.users (id, email, aud, role)
values ('00000000-0000-4000-8000-0000000061a1', 'p6-period-admin@example.invalid', 'authenticated', 'authenticated');
insert into public.admin_users (user_id) values ('00000000-0000-4000-8000-0000000061a1');

create or replace function private.p6_current_time()
returns timestamptz language sql volatile set search_path = ''
as $$ select pg_catalog.current_setting('p6test.now')::timestamptz $$;

create function pg_temp.vals(p_egress text) returns jsonb language sql immutable as $$
  select jsonb_agg(jsonb_build_object('metric', m.code, 'status', 'measured', 'value', case when m.code = 'egress' then p_egress else m.v end, 'unit', m.u, 'quota', m.q) order by m.n)
  from (values
    (1, 'egress', '0', 'GB', '250'),
    (2, 'cached_egress', '0', 'GB', '250'),
    (3, 'edge_function_invocations', '0', 'count', '2000000'),
    (4, 'monthly_active_users', '4', 'count', '100000'),
    (5, 'storage_size', '0', 'GB', '100'),
    (6, 'realtime_messages', '0', 'count', '5000000'),
    (7, 'realtime_peak_connections', '0', 'count', '500'),
    (8, 'log_ingestion', '0.15', 'GB', '20'),
    (9, 'log_query', '23.337', 'GB', '2000'),
    (10, 'disk_size_preview', '2', 'GB', '8'),
    (11, 'disk_size_production', '2', 'GB', '8')) m(n, code, v, u, q)
$$;

create function pg_temp.pre(p_now timestamptz, p_checked timestamptz, p_ps date, p_pe date, p_egress text default '10')
returns jsonb language plpgsql as $$
begin
  perform set_config('p6test.now', p_now::text, true);
  return public.admin_record_p6_usage_check(p_checked, p_ps, p_pe, 'on', null, pg_temp.vals(p_egress), false, null, null);
end;
$$;

create function pg_temp.rec(p_now timestamptz, p_checked timestamptz, p_ps date, p_pe date, p_egress text default '10')
returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  v := pg_temp.pre(p_now, p_checked, p_ps, p_pe, p_egress);
  return public.admin_record_p6_usage_check(p_checked, p_ps, p_pe, 'on', null, pg_temp.vals(p_egress), true, (v ->> 'version')::bigint, (v ->> 'valid')::boolean);
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

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000061a1","role":"authenticated"}', true);
set local role authenticated;

-- ============================================================
-- Open near the end of the period
-- ============================================================

select is((pg_temp.rec('2026-11-29 12:05+00', '2026-11-29 12:00+00', '2026-11-02', '2026-12-02') ->> 'valid')::boolean, true, 'c1 (Nov 29 12:00) valid; the 2026-11-02 dashboard values are accepted');
select is((pg_temp.rec('2026-11-30 12:05+00', '2026-11-30 12:00+00', '2026-11-02', '2026-12-02') ->> 'valid')::boolean, true, 'c2 (Nov 30 12:00) valid');
select is(pg_temp.resume('2026-11-30 12:10+00', 'send'), 'ok', 'sending resumed');
select is(pg_temp.resume('2026-11-30 12:10+00', 'registration'), 'ok', 'registrations resumed');
select is((pg_temp.rec('2026-12-01 05:05+00', '2026-12-01 05:00+00', '2026-11-02', '2026-12-02') ->> 'valid')::boolean, true, 'c3 (Dec 1 05:00, 5 hours before the earliest period end) valid');

-- ============================================================
-- The period end ends the check in force (P1)
-- ============================================================

select is((pg_temp.at('2026-12-01 05:10+00') -> 'state' ->> 'current_check_send_deadline')::timestamptz, '2026-12-01 10:00+00'::timestamptz, 'c3 is in force only until Dec 1 10:00, not 30 hours');
select is(pg_temp.flags('2026-12-01 08:59:59.999999+00'), 'reg=1 tc=1 send=1 grace=0', '1 us before Dec 1 09:00: everything allowed');
select is(pg_temp.flags('2026-12-01 09:00+00'), 'reg=0 tc=0 send=1 grace=1', 'Dec 1 09:00: registrations stop, sending in grace');
select is(pg_temp.flags('2026-12-01 09:59:59.999999+00'), 'reg=0 tc=0 send=1 grace=1', '1 us before Dec 1 10:00: sending still in grace');
select is(pg_temp.flags('2026-12-01 10:00+00'), 'reg=0 tc=0 send=0 grace=0', 'Dec 1 10:00 (earliest possible period end): sending stops');
select is(pg_temp.at('2026-12-01 10:00+00') -> 'state' ->> 'send_stop_reason', 'expired', 'reason: expired at the period end');

-- Around the boundary, a reading is in neither period for sure.
select is(pg_temp.reasons(pg_temp.pre('2026-12-01 10:05+00', '2026-12-01 10:00+00', '2026-11-02', '2026-12-02')), 'period_not_current', 'reading at the earliest end of the old period: invalid');
select is(pg_temp.reasons(pg_temp.pre('2026-12-02 11:05+00', '2026-12-02 11:00+00', '2026-12-02', '2027-01-02')), 'period_not_current', 'reading before the latest start of the new period: invalid');
select is(pg_temp.reasons(pg_temp.pre('2026-12-02 12:05+00', '2026-12-02 12:00+00', '2026-12-02', '2027-01-02', '0')), '', 'reading at the latest start of the new period: valid, lower cumulative usage allowed in the new period');
select is(pg_temp.reasons(pg_temp.pre('2026-12-02 12:05+00', '2026-12-02 12:00+00', '2026-12-05', '2027-01-05', '0')), 'period_not_current,period_mismatch', 'a period that does not follow the last one is invalid');
select is(pg_temp.reasons(pg_temp.pre('2026-12-03 12:05+00', '2026-12-03 12:00+00', '2026-12-03', '2027-01-03', '0')), '', 'a period starting the day after the last end date also follows it (end date shown as the last day)');
select is(pg_temp.reasons(pg_temp.pre('2026-12-02 12:05+00', '2026-12-02 12:00+00', '2026-11-02', '2026-12-02')), 'period_not_current', 'still entering the old period after it ended is invalid');

-- ============================================================
-- Recovery in the new period
-- ============================================================

select is(pg_temp.flags('2026-12-02 12:00+00'), 'reg=0 tc=0 send=0 grace=0', 'nothing reopens with the new period by itself');
select is((pg_temp.rec('2026-12-02 12:05+00', '2026-12-02 12:00+00', '2026-12-02', '2027-01-02', '0') ->> 'valid')::boolean, true, 'c4 (Dec 2 12:00, new period, usage reset) valid');
select is(pg_temp.flags('2026-12-02 12:10+00'), 'reg=0 tc=0 send=0 grace=0', 'one check in the new period reopens nothing');
select is(pg_temp.resume('2026-12-02 12:10+00', 'send'), 'second_check_missing', 'one check after the stop is not enough');
select is((pg_temp.rec('2026-12-03 11:55+00', '2026-12-03 11:50+00', '2026-12-02', '2027-01-02', '0') ->> 'valid')::boolean, true, 'c5 (Dec 3 11:50, 23 h 50 min after c4) valid');
select is(pg_temp.resume('2026-12-03 12:00+00', 'send'), 'second_check_missing', 'less than 24 hours apart is not enough');
select is((pg_temp.rec('2026-12-03 12:05+00', '2026-12-03 12:00+00', '2026-12-02', '2027-01-02', '0') ->> 'valid')::boolean, true, 'c6 (Dec 3 12:00, 24 h after c4) valid');
select is(pg_temp.resume('2026-12-03 12:10+00', 'send'), 'ok', 'sending resumed in the new period');
select is(pg_temp.resume('2026-12-03 12:10+00', 'registration'), 'ok', 'registrations resumed in the new period');
select is(pg_temp.flags('2026-12-03 12:10+00'), 'reg=1 tc=1 send=1 grace=0', 'everything allowed again');

reset role;

select ok(not private.push_registration_intake_open() and not private.push_token_change_open(), 'both gates still closed');

select * from finish();
rollback;
