-- pgTAP tests for P6 STEP A: a data time 24 hours or more before the reading
-- (data_too_old) makes a check invalid. Everything else (29 / 30 hour
-- expiry, the 1-hour grace, 90% / 95%, P1 boundary, resume rules, gates) is
-- checked to be unchanged. One transaction, rolled back; the P6 clock is
-- replaced for this transaction only. Times are UTC.

begin;

create extension if not exists pgtap with schema extensions;

select plan(72);

-- ============================================================
-- The replaced function keeps its shape and privileges
-- ============================================================

select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p
   where p.oid = 'public.admin_record_p6_usage_check(timestamptz, date, date, text, timestamptz, jsonb, boolean, bigint, boolean)'::regprocedure),
  'record RPC: still SECURITY DEFINER with empty search_path');
select is(
  (select pg_catalog.format_type(p.prorettype, null) from pg_proc p
   where p.oid = 'public.admin_record_p6_usage_check(timestamptz, date, date, text, timestamptz, jsonb, boolean, bigint, boolean)'::regprocedure),
  'jsonb', 'record RPC: still returns jsonb');
select is((select count(*)::int from pg_proc where proname = 'admin_record_p6_usage_check'), 1, 'record RPC: one function, no overload added');
select ok(has_function_privilege('authenticated', 'public.admin_record_p6_usage_check(timestamptz, date, date, text, timestamptz, jsonb, boolean, bigint, boolean)', 'execute'), 'record RPC: authenticated may execute (admin checked inside)');
select ok(not (select bool_or(has_function_privilege(x, 'public.admin_record_p6_usage_check(timestamptz, date, date, text, timestamptz, jsonb, boolean, bigint, boolean)', 'execute')) from unnest(array['public','anon','service_role']) x), 'record RPC: not executable by public, anon or service_role');
select ok(
  (select strpos(prosrc, 'private.is_admin()') > 0 and strpos(prosrc, 'private.is_admin()') < strpos(prosrc, 'p6_control') from pg_proc
   where oid = 'public.admin_record_p6_usage_check(timestamptz, date, date, text, timestamptz, jsonb, boolean, bigint, boolean)'::regprocedure),
  'record RPC: the admin check still comes before anything is read or locked');
select ok((select strpos(prosrc, '''30 hours''') > 0 from pg_proc where oid = 'private.p6_check_expires_at(timestamptz, date)'::regprocedure), 'expiry is still 30 hours (STEP A does not change it)');
select is((select btrim(prosrc) from pg_proc where oid = 'private.push_registration_intake_open()'::regprocedure), 'select false', 'registration intake gate still only returns false');
select is((select btrim(prosrc) from pg_proc where oid = 'private.push_token_change_open()'::regprocedure), 'select false', 'token change gate still only returns false');

-- ============================================================
-- Fixtures and helpers (as in p6_usage_monitoring_test.sql)
-- ============================================================

insert into auth.users (id, email, aud, role)
values
  ('00000000-0000-4000-8000-0000000061a1', 'p6-age-admin@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000061b1', 'p6-age-user@example.invalid', 'authenticated', 'authenticated');
insert into public.admin_users (user_id) values ('00000000-0000-4000-8000-0000000061a1');

create or replace function private.p6_current_time()
returns timestamptz language sql volatile set search_path = ''
as $$ select pg_catalog.current_setting('p6test.now')::timestamptz $$;

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

create function pg_temp.egress(p_value text) returns jsonb language sql immutable as $$
  select pg_temp.vals(jsonb_build_object('egress', jsonb_build_object('metric', 'egress', 'status', 'measured', 'value', p_value, 'unit', 'GB', 'quota', '250')))
$$;

create function pg_temp.pre(p_now timestamptz, p_checked timestamptz, p_asof timestamptz default null, p_values jsonb default null)
returns jsonb language plpgsql as $$
begin
  perform set_config('p6test.now', p_now::text, true);
  return public.admin_record_p6_usage_check(p_checked, '2026-11-02', '2026-12-02', 'on', p_asof, coalesce(p_values, pg_temp.vals()), false, null, null);
end;
$$;

create function pg_temp.rec(p_now timestamptz, p_checked timestamptz, p_asof timestamptz default null, p_values jsonb default null)
returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  v := pg_temp.pre(p_now, p_checked, p_asof, p_values);
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
  return public.admin_record_p6_monitoring_failure('usage_unreadable');
end;
$$;

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant select, insert on ids to authenticated;

-- ============================================================
-- Denied callers: the new rule changes nothing for them
-- ============================================================

select set_config('p6test.now', '2026-11-05 00:05+00', true);

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok($$select public.admin_record_p6_usage_check('2026-11-05 00:00+00', '2026-11-02', '2026-12-02', 'on', '2026-11-03 00:00+00', pg_temp.vals(), false, null, null)$$, '42501', null, 'anon: record denied');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000061b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_record_p6_usage_check('2026-11-05 00:00+00', '2026-11-02', '2026-12-02', 'on', '2026-11-03 00:00+00', pg_temp.vals(), false, null, null)$$, '42501', 'insufficient privilege', 'non-admin: record (validate) denied');
select throws_ok($$select public.admin_record_p6_usage_check('2026-11-05 00:00+00', '2026-11-02', '2026-12-02', 'on', '2026-11-03 00:00+00', pg_temp.vals(), true, 1, false)$$, '42501', 'insufficient privilege', 'non-admin: record denied');
select throws_ok($$select count(*) from private.p6_usage_checks$$, '42501', null, 'non-admin: checks not readable');
reset role;

select is((select count(*)::int from private.p6_usage_checks) + (select count(*)::int from private.p6_admin_events), 0, 'denied callers stored nothing');

-- ============================================================
-- The 24-hour boundary (validation only; nothing stored)
-- ============================================================

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000061a1","role":"authenticated"}', true);
set local role authenticated;

select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', '2026-11-04 00:00:00.000001+00')), '', '24 hours minus 1 us before the reading: not too old');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', '2026-11-04 00:00+00')), 'data_too_old', 'exactly 24 hours before the reading: too old');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', '2026-11-03 23:00+00')), 'data_too_old', '25 hours before the reading: too old');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', '2026-11-02 12:00+00')), 'data_too_old', 'inside the period but days old: too old');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', null)), '', 'no data time shown: the age is not checked');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', '2026-11-05 00:00+00')), '', 'data time equal to the reading: not too old');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', '2026-11-05 00:00:00.000001+00')), 'data_as_of_future', 'data time after the reading: still data_as_of_future only');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', '2026-11-01 00:00+00')), 'data_stale,data_too_old', 'data time before the period: data_stale, and too old');
select is(
  pg_temp.reasons(public.admin_record_p6_usage_check('2026-11-05 00:00+00', '2026-11-02', '2026-12-02', 'off', '2026-11-04 00:00+00', pg_temp.vals(), false, null, null)),
  'spend_cap_not_on,data_too_old', 'other reasons still apply alongside data_too_old');
-- Direct table reads need the owner role (the admin role cannot read them).
reset role;
select is((select count(*)::int from private.p6_usage_checks), 0, 'validation stored nothing');
set local role authenticated;

-- ============================================================
-- A normal start: two checks 24 hours apart with the same zero values
-- (one with a data time, one without), then an explicit resume
-- ============================================================

select is((pg_temp.rec('2026-11-05 00:05+00', '2026-11-05 00:00+00', '2026-11-04 23:00+00') ->> 'valid')::boolean, true, 'c1 (data 1 hour old) valid');
-- Older than the previous data time but not 24 hours old: data_stale only.
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 01:05+00', '2026-11-05 01:00+00', '2026-11-04 22:30+00')), 'data_stale', 'a data time before the previous one: data_stale only');
select is((pg_temp.rec('2026-11-06 00:05+00', '2026-11-06 00:00+00') ->> 'valid')::boolean, true, 'c2 (no data time, same zero values) valid');
select is(pg_temp.resume('2026-11-06 00:10+00', 'send'), 'ok', 'two valid checks with the same zero values: sending resumed');
select is(pg_temp.resume('2026-11-06 00:10+00', 'registration'), 'ok', 'registrations resumed');
select is(pg_temp.flags('2026-11-06 00:10+00'), 'reg=1 tc=1 send=1 grace=0', 'everything allowed');

-- ============================================================
-- A too-old check is an invalid check: stored, audited, a monitoring
-- incident (registrations stop at once, sending gets the 1-hour grace)
-- ============================================================

insert into ids select 'c3', (pg_temp.rec('2026-11-06 06:05+00', '2026-11-06 06:00+00', '2026-11-05 06:00+00') ->> 'check_id')::uuid;
reset role;
select is((select is_valid from private.p6_usage_checks where id = (select id from ids where name = 'c3')), false, 'c3 (data exactly 24 hours old) stored as invalid');
select is((select invalid_reasons from private.p6_usage_checks where id = (select id from ids where name = 'c3')), array['data_too_old'], 'c3 reason: data_too_old');
select is((select data_as_of from private.p6_usage_checks where id = (select id from ids where name = 'c3')), '2026-11-05 06:00+00'::timestamptz, 'c3 keeps the data time as entered');
select is((select code from private.p6_admin_events where check_id = (select id from ids where name = 'c3')), 'invalid', 'c3 audited as an invalid record_check');
select is((select count(*)::int from private.p6_warnings where kind = 'monitoring' and check_id = (select id from ids where name = 'c3')), 1, 'c3 stored one monitoring warning');
set local role authenticated;
select is(pg_temp.flags('2026-11-06 06:05+00'), 'reg=0 tc=0 send=1 grace=1', 'right after c3: registrations stop, sending in grace');
select is(pg_temp.at('2026-11-06 06:05+00') -> 'state' ->> 'registration_stop_reason', 'invalid_check', 'registration reason: invalid check');
select is((pg_temp.at('2026-11-06 06:05+00') -> 'state' ->> 'send_grace_until')::timestamptz, '2026-11-06 07:05+00'::timestamptz, 'grace until c3 + 1 hour');
select isnt(pg_temp.fail('2026-11-06 06:30+00'), null, 'a failure during the grace hour');
select is((pg_temp.rec('2026-11-06 06:45+00', '2026-11-06 06:40+00') ->> 'valid')::boolean, true, 'c4 (fresh, during the grace hour) valid');
select is((pg_temp.at('2026-11-06 06:45+00') -> 'state' ->> 'send_grace_until')::timestamptz, '2026-11-06 07:05+00'::timestamptz, 'neither the failure nor c4 extends the grace');
select is(pg_temp.flags('2026-11-06 07:04:59.999999+00'), 'reg=0 tc=0 send=1 grace=1', '1 hour minus 1 us: sending still in grace');
select is(pg_temp.flags('2026-11-06 07:05+00'), 'reg=0 tc=0 send=0 grace=0', '1 hour after c3: sending stops');
select is(pg_temp.at('2026-11-06 07:05+00') -> 'state' ->> 'send_stop_reason', 'invalid_check', 'send reason: invalid check');
select is(pg_temp.resume('2026-11-06 07:10+00', 'send'), 'no_check_after_stop', 'no automatic or immediate resume');

-- ============================================================
-- Old data cannot be one of the two checks a resume needs
-- ============================================================

select is((pg_temp.rec('2026-11-07 07:05+00', '2026-11-07 07:00+00', '2026-11-07 06:30+00') ->> 'valid')::boolean, true, 'c5 (data 30 minutes old) valid');
-- The same data time again a day later is 24 hours or more old.
select is(pg_temp.reasons(pg_temp.rec('2026-11-08 07:05+00', '2026-11-08 07:00+00', '2026-11-07 06:30+00')), 'data_too_old', 'c6 repeats c5''s data time 24.5 hours later: too old');
select is(pg_temp.resume('2026-11-08 07:10+00', 'send'), 'second_check_missing', 'the same old data cannot count as the second check');
-- Registrations stopped earlier (at c3), so the fresh c4 read during the
-- grace hour is after their stop; the too-old c6 then sits between the two
-- checks and still refuses the resume.
select is(pg_temp.resume('2026-11-08 07:10+00', 'registration'), 'invalid_between_checks', 'nor for registrations (c6 between c4 and c5)');
select is((pg_temp.rec('2026-11-09 07:05+00', '2026-11-09 07:00+00') ->> 'valid')::boolean, true, 'c7 (no data time) valid');
select is(pg_temp.resume('2026-11-09 07:10+00', 'send'), 'invalid_between_checks', 'the too-old c6 between c5 and c7 blocks the resume');
select is((pg_temp.rec('2026-11-10 07:05+00', '2026-11-10 07:00+00', '2026-11-10 06:00+00') ->> 'valid')::boolean, true, 'c8 (data 1 hour old, same zero values) valid');
select is(pg_temp.resume('2026-11-10 07:10+00', 'send'), 'ok', 'c7 and c8 (24 hours apart, same values): sending resumed by the admin');
select is(pg_temp.resume('2026-11-10 07:10+00', 'registration'), 'ok', 'registrations resumed by the admin');

select is(pg_temp.flags('2026-11-10 07:10+00'), 'reg=1 tc=1 send=1 grace=0', 'everything allowed again');

-- ============================================================
-- Unchanged: 29 / 30 hour expiry from checked_at
-- ============================================================

select is((pg_temp.at('2026-11-10 07:10+00') -> 'state' ->> 'current_check_registration_deadline')::timestamptz, '2026-11-11 12:00+00'::timestamptz, 'registration deadline: c8 read + 29 hours');
select is((pg_temp.at('2026-11-10 07:10+00') -> 'state' ->> 'current_check_send_deadline')::timestamptz, '2026-11-11 13:00+00'::timestamptz, 'send deadline: c8 read + 30 hours');
select is(pg_temp.flags('2026-11-11 11:59:59.999999+00'), 'reg=1 tc=1 send=1 grace=0', '29 h minus 1 us: everything allowed');
select is(pg_temp.flags('2026-11-11 12:00+00'), 'reg=0 tc=0 send=1 grace=1', '29 h: registrations stop, sending in grace');
select is(pg_temp.flags('2026-11-11 12:59:59.999999+00'), 'reg=0 tc=0 send=1 grace=1', '30 h minus 1 us: sending still in grace');
select is(pg_temp.flags('2026-11-11 13:00+00'), 'reg=0 tc=0 send=0 grace=0', '30 h: sending stops');

-- ============================================================
-- Unchanged: 90% and 95% stop at once
-- ============================================================

select is((pg_temp.rec('2026-11-10 09:05+00', '2026-11-10 09:00+00', '2026-11-10 08:30+00', pg_temp.egress('225')) ->> 'valid')::boolean, true, 'c9: egress 90.000% valid');
select is(pg_temp.flags('2026-11-10 09:05+00'), 'reg=0 tc=1 send=1 grace=0', '90%: registrations stop at once; sending and token changes go on');
select is((pg_temp.rec('2026-11-10 10:05+00', '2026-11-10 10:00+00', null, pg_temp.egress('237.5')) ->> 'valid')::boolean, true, 'c10: egress 95.000% valid');
select is(pg_temp.flags('2026-11-10 10:05+00'), 'reg=0 tc=0 send=0 grace=0', '95%: sending stops at once, no grace');
select is(pg_temp.at('2026-11-10 10:05+00') -> 'state' ->> 'send_stop_reason', 'usage_95', 'send reason: 95%');

-- ============================================================
-- Unchanged: P1 billing-period boundary (helpers are owner-only)
-- ============================================================

reset role;
select is(private.p6_check_expires_at('2026-12-01 00:00+00', '2026-12-02'), '2026-12-01 10:00+00'::timestamptz, 'P1: a check near the period end is in force only until the earliest possible end');
select is(private.p6_check_deadline('2026-12-01 00:00+00', '2026-12-02'), '2026-12-01 09:00+00'::timestamptz, 'P1: registrations stop 1 hour before it');

-- ============================================================
-- Audit and version stay consistent; the gates are still closed
-- ============================================================

select is((select count(*)::int from private.p6_admin_events where action = 'record_check'), (select count(*)::int from private.p6_usage_checks), 'one record_check event per stored check');
select is((select count(*)::int from private.p6_usage_checks where 'data_too_old' = any (invalid_reasons)), 2, 'two checks stored as too old (c3, c6)');
select is((select version from private.p6_control), 1 + (select count(*) from private.p6_admin_events where action <> 'resume_refused'), 'the version moved once per write');
select ok(not private.push_registration_intake_open() and not private.push_token_change_open(), 'both gates still closed');

select * from finish();
rollback;
