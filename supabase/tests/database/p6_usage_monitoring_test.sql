-- pgTAP tests for the P6 usage monitoring core (roadmap 3, P6).
-- Everything runs inside one transaction and is rolled back. The P6 clock
-- (private.p6_current_time) is replaced for this transaction so that each
-- step runs at an exact time; the timeline below is in UTC. One transaction
-- cannot test real concurrency; that is checked separately.

begin;

create extension if not exists pgtap with schema extensions;

select plan(202);

-- ============================================================
-- Structure, grants and RLS
-- ============================================================

select is((select count(*)::int from pg_tables where schemaname = 'private' and tablename like 'p6\_%'), 9, 'nine P6 tables in schema private');
select ok((select bool_and(c.relrowsecurity) from pg_class c where c.relnamespace = 'private'::regnamespace and c.relname like 'p6\_%' and c.relkind = 'r'), 'RLS enabled on every P6 table');
select is((select count(*)::int from pg_policies where schemaname = 'private' and tablename like 'p6\_%'), 0, 'no policies on the P6 tables');
select ok(not (select bool_or(has_table_privilege(r, c.oid, p)) from unnest(array['public','anon','authenticated','service_role']) r, pg_class c, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where c.relnamespace = 'private'::regnamespace and c.relname like 'p6\_%' and c.relkind = 'r'), 'no table privilege for public, anon, authenticated or service_role');
select is((select count(*)::int from pg_tables where schemaname = 'public' and tablename like 'p6%'), 0, 'no P6 table in schema public');

create temporary table p6_rpcs (sig regprocedure) on commit drop;
insert into p6_rpcs values
  ('public.admin_record_p6_usage_check(timestamptz, date, date, text, timestamptz, jsonb, boolean, bigint, boolean)'::regprocedure),
  ('public.admin_void_p6_usage_check(uuid, text, bigint)'::regprocedure),
  ('public.admin_record_p6_monitoring_failure(text)'::regprocedure),
  ('public.admin_stop_p6(text)'::regprocedure),
  ('public.admin_resume_p6(text, bigint)'::regprocedure),
  ('public.admin_get_p6_status()'::regprocedure);

select ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p join p6_rpcs r on r.sig = p.oid), 'P6 RPCs: SECURITY DEFINER with empty search_path');
select ok((select bool_and(has_function_privilege('authenticated', sig, 'execute')) from p6_rpcs), 'P6 RPCs: authenticated may execute (admin checked inside)');
select ok(not (select bool_or(has_function_privilege(x, sig, 'execute')) from p6_rpcs, unnest(array['public','anon','service_role']) x), 'P6 RPCs: not executable by public, anon or service_role');
select ok(not (select bool_or(has_function_privilege(x, p.oid, 'execute')) from pg_proc p, unnest(array['public','anon','authenticated','service_role']) x where p.pronamespace = 'private'::regnamespace and p.proname like 'p6\_%'), 'P6 helpers: not executable by any client role');
select ok((select bool_and(not p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname like 'p6\_%'), 'P6 helpers: SECURITY INVOKER with empty search_path');
select ok((select provolatile = 'v' and btrim(prosrc) = 'select pg_catalog.clock_timestamp()' from pg_proc where oid = 'private.p6_current_time()'::regprocedure), 'the P6 clock is clock_timestamp() after the migration');

-- The gates are untouched and nothing outside P6 reads the state.
select is((select btrim(prosrc) from pg_proc where oid = 'private.push_registration_intake_open()'::regprocedure), 'select false', 'registration intake gate still only returns false');
select is((select btrim(prosrc) from pg_proc where oid = 'private.push_token_change_open()'::regprocedure), 'select false', 'token change gate still only returns false');
select ok(not private.push_registration_intake_open() and not private.push_token_change_open(), 'both gates are closed');
select is((select coalesce(array_agg(n.nspname || '.' || p.proname order by p.proname), '{}') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where strpos(p.prosrc, 'p6_state(') > 0), array['public.admin_get_p6_status'], 'only the status RPC reads p6_state (no gate, no push RPC)');
select is((select coalesce(array_agg(n.nspname || '.' || p.proname order by p.proname), '{}') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where strpos(p.prosrc, 'p6_') > 0 and (p.proname like '%push%' or p.proname like '%registration%')), '{}'::text[], 'no push or registration function refers to P6');

select is(
  (select string_agg(code || ':' || scope || ':' || coalesce(project, '-') || ':' || kind || ':' || unit_kind || ':' || quota::text, ',' order by sort_order) from private.p6_metrics),
  'egress:organization:-:cumulative:bytes:250,cached_egress:organization:-:cumulative:bytes:250,edge_function_invocations:organization:-:cumulative:count:2000000,monthly_active_users:organization:-:cumulative:count:100000,storage_size:organization:-:average:bytes:100,realtime_messages:organization:-:cumulative:count:5000000,realtime_peak_connections:organization:-:peak:count:500,log_ingestion:organization:-:cumulative:bytes:20,log_query:organization:-:cumulative:bytes:2000,disk_size_preview:project:preview:provisioned:bytes:8,disk_size_production:project:production:provisioned:bytes:8',
  'the eleven required metrics, their scope, kind, unit and Pro quota');
select is((select row(version, registration_resumed_at, send_resumed_at)::text from private.p6_control), row(1::bigint, null::timestamptz, null::timestamptz)::text, 'control row starts at version 1, never resumed');

-- ============================================================
-- Thresholds (exact numeric comparison)
-- ============================================================

select is(private.p6_level(149.9975, 250), 0::smallint, '59.999% -> below 60');
select is(private.p6_level(150, 250), 60::smallint, '60.000% -> 60');
select is(private.p6_level(199.9975, 250), 60::smallint, '79.999% -> 60');
select is(private.p6_level(200, 250), 80::smallint, '80.000% -> 80');
select is(private.p6_level(224.9975, 250), 80::smallint, '89.999% -> 80');
select is(private.p6_level(225, 250), 90::smallint, '90.000% -> 90');
select is(private.p6_level(237.4975, 250), 90::smallint, '94.999% -> 90');
select is(private.p6_level(237.5, 250), 95::smallint, '95.000% -> 95');
select is(private.p6_level(224.999999999, 250), 80::smallint, '89.9999999996% stays below 90 (no rounding up)');
select is(private.p6_level(89999, 100000), 80::smallint, 'MAU 89,999 / 100,000 -> 80');
select is(private.p6_level(90000, 100000), 90::smallint, 'MAU 90,000 / 100,000 -> 90');
select is(private.p6_level(475, 500), 95::smallint, 'peak connections 475 / 500 -> 95');

-- ============================================================
-- Fixtures and helpers
-- ============================================================

insert into auth.users (id, email, aud, role)
values
  ('00000000-0000-4000-8000-0000000060a1', 'p6-admin@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000060b1', 'p6-user@example.invalid', 'authenticated', 'authenticated');
insert into public.admin_users (user_id) values ('00000000-0000-4000-8000-0000000060a1');

-- The P6 clock reads p6test.now for this transaction only (rolled back).
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

create function pg_temp.egress(p_value text, p_unit text default 'GB') returns jsonb language sql immutable as $$
  select pg_temp.one('egress', jsonb_build_object('status', 'measured', 'value', p_value, 'unit', p_unit, 'quota', '250'))
$$;

create function pg_temp.pre(
  p_now timestamptz, p_checked timestamptz, p_values jsonb default null, p_cap text default 'on',
  p_ps date default '2026-11-02', p_pe date default '2026-12-02', p_asof timestamptz default null
) returns jsonb language plpgsql as $$
begin
  perform set_config('p6test.now', p_now::text, true);
  return public.admin_record_p6_usage_check(p_checked, p_ps, p_pe, p_cap, p_asof, coalesce(p_values, pg_temp.vals()), false, null, null);
end;
$$;

-- Validate, then commit with the version and validity the validation saw
-- (what the admin page does).
create function pg_temp.rec(
  p_now timestamptz, p_checked timestamptz, p_values jsonb default null, p_cap text default 'on',
  p_ps date default '2026-11-02', p_pe date default '2026-12-02', p_asof timestamptz default null
) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  v := pg_temp.pre(p_now, p_checked, p_values, p_cap, p_ps, p_pe, p_asof);
  return public.admin_record_p6_usage_check(p_checked, p_ps, p_pe, p_cap, p_asof, coalesce(p_values, pg_temp.vals()), true, (v ->> 'version')::bigint, (v ->> 'valid')::boolean);
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

create function pg_temp.fail(p_now timestamptz, p_kind text default 'dashboard_unavailable') returns uuid language plpgsql as $$
begin
  perform set_config('p6test.now', p_now::text, true);
  return public.admin_record_p6_monitoring_failure(p_kind);
end;
$$;

create function pg_temp.stop(p_now timestamptz) returns uuid language plpgsql as $$
begin
  perform set_config('p6test.now', p_now::text, true);
  return public.admin_stop_p6('usage_concern');
end;
$$;

create function pg_temp.void(p_now timestamptz, p_id uuid) returns void language plpgsql as $$
begin
  perform public.admin_void_p6_usage_check(p_id, 'input_error', (pg_temp.at(p_now) -> 'state' ->> 'version')::bigint);
end;
$$;

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant select, insert on ids to authenticated;

-- ============================================================
-- Denied callers
-- ============================================================

select set_config('p6test.now', '2026-11-05 00:00+00', true);

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok($$select public.admin_get_p6_status()$$, '42501', null, 'anon: status denied');
select throws_ok($$select public.admin_stop_p6('other')$$, '42501', null, 'anon: stop denied');
select throws_ok($$select count(*) from private.p6_usage_checks$$, '42501', null, 'anon: private table not readable');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000060b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_get_p6_status()$$, '42501', 'insufficient privilege', 'non-admin: status denied');
select throws_ok($$select public.admin_record_p6_usage_check('2026-11-05 00:00+00', '2026-11-02', '2026-12-02', 'on', null, pg_temp.vals(), false, null, null)$$, '42501', 'insufficient privilege', 'non-admin: record (validate only) denied');
select throws_ok($$select public.admin_record_p6_usage_check('2026-11-05 00:00+00', '2026-11-02', '2026-12-02', 'on', null, pg_temp.vals(), true, 1, true)$$, '42501', 'insufficient privilege', 'non-admin: record denied');
select throws_ok($$select public.admin_void_p6_usage_check(gen_random_uuid(), 'other', 1)$$, '42501', 'insufficient privilege', 'non-admin: void denied');
select throws_ok($$select public.admin_record_p6_monitoring_failure('other')$$, '42501', 'insufficient privilege', 'non-admin: failure denied');
select throws_ok($$select public.admin_stop_p6('other')$$, '42501', 'insufficient privilege', 'non-admin: stop denied');
select throws_ok($$select public.admin_resume_p6('send', 1)$$, '42501', 'insufficient privilege', 'non-admin: resume denied');
select throws_ok($$select count(*) from private.p6_control$$, '42501', null, 'non-admin: private table not readable');
select throws_ok($$insert into private.p6_manual_stops (reason, stopped_at, stopped_by) values ('other', now(), auth.uid())$$, '42501', null, 'non-admin: private table not writable');
select throws_ok($$select private.p6_state(now())$$, '42501', null, 'non-admin: p6_state not callable');
reset role;

select is((select (select count(*) from private.p6_usage_checks) + (select count(*) from private.p6_manual_stops) + (select count(*) from private.p6_monitoring_failures) + (select count(*) from private.p6_admin_events))::int, 0, 'denied callers stored nothing');

-- ============================================================
-- Input: malformed input is refused (22023) and stores nothing
-- ============================================================

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000060a1","role":"authenticated"}', true);
set local role authenticated;
select set_config('p6test.now', '2026-11-05 00:05+00', true);

select throws_ok($$select public.admin_record_p6_usage_check('2026-11-05 00:00+00', '2026-11-02', '2026-12-02', 'on', null, (select jsonb_agg(e) from jsonb_array_elements(pg_temp.vals()) e where e ->> 'metric' <> 'log_query'), false, null, null)$$, '22023', null, 'a missing metric is refused');
select throws_ok($$select public.admin_record_p6_usage_check('2026-11-05 00:00+00', '2026-11-02', '2026-12-02', 'on', null, (select jsonb_agg(case when e ->> 'metric' = 'log_query' then e || '{"metric":"egress"}' else e end) from jsonb_array_elements(pg_temp.vals()) e), false, null, null)$$, '22023', null, 'a repeated metric is refused');
select throws_ok($$select public.admin_record_p6_usage_check('2026-11-05 00:00+00', '2026-11-02', '2026-12-02', 'on', null, (select jsonb_agg(case when e ->> 'metric' = 'log_query' then '{"metric":"nonexistent","status":"unavailable"}'::jsonb else e end) from jsonb_array_elements(pg_temp.vals()) e), false, null, null)$$, '22023', null, 'an unknown metric is refused');
select throws_ok($$select pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.egress('abc'))$$, '22023', null, 'a non-numeric value is refused');
select throws_ok($$select pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.egress('-1'))$$, '22023', null, 'a negative value is refused');
select throws_ok($$select pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.egress('1e3'))$$, '22023', null, 'exponent notation is refused');
select throws_ok($$select pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.egress(''))$$, '22023', null, 'an empty value is refused');
select throws_ok($$select pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.egress('1', 'TB'))$$, '22023', null, 'an unsupported unit (TB) is refused');
select throws_ok($$select pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.egress('1', 'count'))$$, '22023', null, 'a count unit on a byte metric is refused');
select throws_ok($$select pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.one('monthly_active_users', '{"status":"measured","value":"4","unit":"GB","quota":"100000"}'))$$, '22023', null, 'a byte unit on a count metric is refused');
select throws_ok($$select pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.one('monthly_active_users', '{"status":"measured","value":"4.5","unit":"count","quota":"100000"}'))$$, '22023', null, 'a fractional count is refused');
select throws_ok($$select pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.one('egress', '{"status":"measured","value":1,"unit":"GB","quota":"250"}'))$$, '22023', null, 'a JSON number instead of a decimal string is refused');
select throws_ok($$select pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.one('egress', '{"status":"unavailable","value":"0"}'))$$, '22023', null, 'an unavailable metric with a value is refused');
select throws_ok($$select pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.one('egress', '{"status":"zero"}'))$$, '22023', null, 'an unknown status is refused');
select throws_ok($$select pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', null, 'maybe')$$, '22023', null, 'an unknown spend cap state is refused');
select throws_ok($$select pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', null, 'on', '2026-12-02', '2026-11-02')$$, '22023', null, 'a period ending before it starts is refused');
select throws_ok($$select public.admin_record_p6_usage_check('2026-11-05 00:00+00', '2026-11-02', '2026-12-02', 'on', null, pg_temp.vals(), true, null, true)$$, '22023', null, 'a commit without the page version is refused');
select throws_ok($$select public.admin_record_p6_usage_check('2026-11-05 00:00+00', '2026-11-02', '2026-12-02', 'on', null, pg_temp.vals(), true, 1, null)$$, '22023', null, 'a commit without the shown validity is refused');

-- ============================================================
-- Input: rules (validation only; nothing is stored)
-- ============================================================

select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00')), '', 'all eleven measured (zero usage) is valid');
select is((pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00') -> 'values' -> 0 ->> 'usage')::numeric, 0::numeric, 'zero is stored as a measured 0');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.one('storage_size', '{"status":"unavailable"}'))), 'metric_unavailable', 'an unreadable metric makes the check invalid');
select ok((pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.one('storage_size', '{"status":"unavailable"}')) -> 'values' -> 4) = '{"metric":"storage_size","status":"unavailable"}'::jsonb, 'an unreadable metric has no usage and no level (never 0)');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.one('egress', '{"status":"measured","value":"0","unit":"GB","quota":"200"}'))), 'quota_mismatch', 'a quota different from the Pro quota makes the check invalid');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.one('disk_size_production', '{"status":"measured","value":"2","unit":"GB","quota":"8.0"}'))), '', '8.0 equals the 8 GB quota');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', null, 'off')), 'spend_cap_not_on', 'spend cap off makes the check invalid');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', null, 'unknown')), 'spend_cap_not_on', 'spend cap unknown makes the check invalid');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:06+00')), 'checked_at_future', 'a dashboard time in the future makes the check invalid');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 01:00+00', '2026-11-05 00:00+00')), '', 'recorded exactly 1 hour after reading: valid');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 01:00:00.000001+00', '2026-11-05 00:00+00')), 'recorded_too_late', 'recorded more than 1 hour after reading: invalid');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', null, 'on', '2026-11-02', '2026-11-05')), 'period_invalid', 'a 3-day billing period is invalid');
select is(pg_temp.reasons(pg_temp.pre('2026-11-02 11:05+00', '2026-11-02 11:00+00')), 'period_not_current', 'a reading before the latest possible period start is invalid');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', null, 'on', '2026-11-02', '2026-12-02', '2026-11-05 00:01+00')), 'data_as_of_future', 'a data time after the reading is invalid');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', null, 'on', '2026-11-02', '2026-12-02', '2026-11-01 00:00+00')), 'data_stale,data_too_old', 'a data time before the period is invalid (and, being 24 hours or more before the reading, also too old)');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', null, 'on', '2026-11-02', '2026-12-02', '2026-11-04 23:00+00')), '', 'a data time inside the period is kept');
select is(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.egress('500', 'MB')) -> 'values' -> 0 ->> 'usage', '0.50000000000000000000', '500 MB is converted to 0.5 GB on the server');
select is((pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.egress('1', 'KB')) -> 'values' -> 0 ->> 'usage')::numeric, 0.000001::numeric, '1 KB is converted to 0.000001 GB');
select is((pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.egress('225000', 'MB')) -> 'values' -> 0 ->> 'level')::int, 90, '225,000 MB reaches the 90% level');
select is(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.egress('224.99999')) -> 'values' -> 0 ->> 'percent', '89.999', 'the shown percentage is truncated, never rounded up');
select is((pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.egress('224.99999')) -> 'values' -> 0 ->> 'level')::int, 80, '89.999996% stays at the 80% level');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:05+00', '2026-11-05 00:00+00', pg_temp.one('storage_size', '{"status":"unavailable"}'), 'off')), 'metric_unavailable,spend_cap_not_on', 'several reasons are all reported');

reset role;
select is((select count(*)::int from private.p6_usage_checks), 0, 'validation stored no check');
select is((select version from private.p6_control), 1::bigint, 'validation did not change the version');
set local role authenticated;

-- ============================================================
-- First check, duplicates and stale pages
-- ============================================================

select is((pg_temp.rec('2026-11-05 00:05+00', '2026-11-05 00:00+00') ->> 'valid')::boolean, true, 'c1 (Nov 5 00:00) stored as valid');
select throws_ok($$select pg_temp.rec('2026-11-05 00:10+00', '2026-11-05 00:00+00')$$, '23505', null, 'the same dashboard time again is refused (not stored)');
select throws_ok($$select public.admin_record_p6_usage_check('2026-11-05 00:08+00', '2026-11-02', '2026-12-02', 'on', null, pg_temp.vals(), true, 1, true)$$, 'P0409', null, 'a commit from a stale page is refused');
select throws_ok($$select public.admin_record_p6_usage_check('2026-11-05 00:08+00', '2026-11-02', '2026-12-02', 'on', null, pg_temp.vals(), true, (pg_temp.at('2026-11-05 00:10+00') -> 'state' ->> 'version')::bigint, false)$$, 'P0409', null, 'a commit whose validity differs from the shown one is refused');
select is(pg_temp.reasons(pg_temp.pre('2026-11-05 00:10+00', '2026-11-04 23:59+00')), 'checked_at_not_newer', 'a reading older than the last check is invalid');

reset role;
select is((select count(*)::int from private.p6_usage_checks), 1, 'only c1 was stored');
select is((select count(*)::int from private.p6_usage_values), 11, 'c1 has eleven values');
select is((select string_agg(action || ':' || code || ':' || actor::text, ',') from private.p6_admin_events), 'record_check:valid:00000000-0000-4000-8000-0000000060a1', 'c1 audited once with the admin');
set local role authenticated;

-- Never resumed: everything is stopped, even with a valid check.
select is(pg_temp.flags('2026-11-05 00:10+00'), 'reg=0 tc=0 send=0 grace=0', 'before the first resume nothing is allowed');
select is(pg_temp.at('2026-11-05 00:10+00') -> 'state' ->> 'send_stop_reason', 'not_started', 'reason: not started');

-- ============================================================
-- First resume: two valid checks at least 24 hours apart
-- ============================================================

select is((pg_temp.rec('2026-11-05 23:05+00', '2026-11-05 23:00+00') ->> 'valid')::boolean, true, 'c2 (Nov 5 23:00) valid');
select is(pg_temp.resume('2026-11-05 23:10+00', 'send'), 'second_check_missing', '23 hours apart is not enough');
select is((pg_temp.rec('2026-11-06 00:05+00', '2026-11-06 00:00+00') ->> 'valid')::boolean, true, 'c3 (Nov 6 00:00) valid');
select throws_ok($$select public.admin_resume_p6('send', 1)$$, 'P0409', null, 'resume from a stale page is refused');
select is(pg_temp.resume('2026-11-06 00:10+00', 'send'), 'ok', 'exactly 24 hours apart (c1, c3): sending resumed');
select is(pg_temp.flags('2026-11-06 00:10+00'), 'reg=0 tc=1 send=1 grace=0', 'sending and token changes allowed, registrations still stopped');
select is(pg_temp.resume('2026-11-06 00:10+00', 'registration'), 'ok', 'registrations resumed');
select is(pg_temp.resume('2026-11-06 00:10+00', 'send'), 'not_stopped', 'resuming an open target is refused');
select is(pg_temp.flags('2026-11-06 00:10+00'), 'reg=1 tc=1 send=1 grace=0', 'everything allowed');

-- ============================================================
-- Expiry: 29 hours stops registrations, 30 hours stops sending
-- ============================================================

select is((pg_temp.at('2026-11-06 00:10+00') -> 'state' ->> 'current_check_registration_deadline')::timestamptz, '2026-11-07 05:00+00'::timestamptz, 'registration deadline: reading + 29 hours');
select is((pg_temp.at('2026-11-06 00:10+00') -> 'state' ->> 'current_check_send_deadline')::timestamptz, '2026-11-07 06:00+00'::timestamptz, 'send deadline: reading + 30 hours');
select is(pg_temp.flags('2026-11-07 04:59:59.999999+00'), 'reg=1 tc=1 send=1 grace=0', '29 h minus 1 us: everything allowed');
select is(pg_temp.flags('2026-11-07 05:00+00'), 'reg=0 tc=0 send=1 grace=1', '29 h: registrations and token changes stop, sending in grace');
select is(pg_temp.at('2026-11-07 05:00+00') -> 'state' ->> 'registration_stop_reason', 'expired', 'reason: expired');
select is(pg_temp.flags('2026-11-07 05:59:59.999999+00'), 'reg=0 tc=0 send=1 grace=1', '30 h minus 1 us: sending still in grace');
select is(pg_temp.flags('2026-11-07 06:00+00'), 'reg=0 tc=0 send=0 grace=0', '30 h: sending stops');

-- A valid check during the grace hour neither reopens nor extends anything.
select is((pg_temp.rec('2026-11-07 05:30+00', '2026-11-07 05:20+00') ->> 'valid')::boolean, true, 'c4 (Nov 7 05:20, during the grace hour) valid');
select is(pg_temp.flags('2026-11-07 05:30+00'), 'reg=0 tc=0 send=1 grace=1', 'c4 does not reopen registrations');
select is(pg_temp.flags('2026-11-07 06:00+00'), 'reg=0 tc=0 send=0 grace=0', 'c4 does not extend the grace hour');
select is((pg_temp.at('2026-11-07 06:00+00') -> 'state' ->> 'send_grace_until')::timestamptz, '2026-11-07 06:00+00'::timestamptz, 'grace end unchanged');

-- ============================================================
-- Recovery after expiry
-- ============================================================

select is(pg_temp.resume('2026-11-07 06:30+00', 'send'), 'no_check_after_stop', 'send: c4 was read before sending stopped');
select is(pg_temp.resume('2026-11-07 06:30+00', 'registration'), 'second_check_missing', 'registration: only one check after its stop');
select is((pg_temp.rec('2026-11-07 07:05+00', '2026-11-07 07:00+00') ->> 'valid')::boolean, true, 'c5 (Nov 7 07:00) valid');
select isnt(pg_temp.fail('2026-11-07 08:00+00'), null, 'failure recorded at Nov 7 08:00');
select is((pg_temp.rec('2026-11-08 07:35+00', '2026-11-08 07:30+00') ->> 'valid')::boolean, true, 'c6 (Nov 8 07:30) valid');
select is(pg_temp.resume('2026-11-08 07:40+00', 'send'), 'failure_between_checks', 'a failure between the two checks blocks the resume');
select is((pg_temp.rec('2026-11-09 08:05+00', '2026-11-09 08:00+00') ->> 'valid')::boolean, true, 'c7 (Nov 9 08:00) valid');
select is(pg_temp.resume('2026-11-09 08:10+00', 'send'), 'ok', 'c6 and c7 (24.5 h, zero usage both times): sending resumed');
select is(pg_temp.resume('2026-11-09 08:10+00', 'registration'), 'ok', 'registrations resumed');
select is(pg_temp.flags('2026-11-09 08:10+00'), 'reg=1 tc=1 send=1 grace=0', 'everything allowed again');

-- ============================================================
-- Monitoring failure: registrations stop at once, sending gets 1 hour
-- ============================================================

select isnt(pg_temp.fail('2026-11-09 10:00+00', 'usage_unreadable'), null, 'failure recorded at Nov 9 10:00');
select is(pg_temp.flags('2026-11-09 10:00+00'), 'reg=0 tc=0 send=1 grace=1', 'right after the failure: registrations stop, sending in grace');
select is(pg_temp.at('2026-11-09 10:00+00') -> 'state' ->> 'registration_stop_reason', 'monitoring_failure', 'reason: monitoring failure');
select is((pg_temp.at('2026-11-09 10:00+00') -> 'state' ->> 'send_grace_until')::timestamptz, '2026-11-09 11:00+00'::timestamptz, 'grace until failure + 1 hour');
select isnt(pg_temp.fail('2026-11-09 10:30+00'), null, 'a second failure at 10:30');
select is((pg_temp.rec('2026-11-09 10:40+00', '2026-11-09 10:35+00') ->> 'valid')::boolean, true, 'c8 (10:35) valid during the grace hour');
select is((pg_temp.at('2026-11-09 10:40+00') -> 'state' ->> 'send_grace_until')::timestamptz, '2026-11-09 11:00+00'::timestamptz, 'neither the second failure nor c8 extends the grace');
select is(pg_temp.flags('2026-11-09 10:59:59.999999+00'), 'reg=0 tc=0 send=1 grace=1', '1 h minus 1 us: sending still in grace');
select is(pg_temp.flags('2026-11-09 11:00+00'), 'reg=0 tc=0 send=0 grace=0', '1 h after the failure: sending stops');
select is(pg_temp.at('2026-11-09 11:00+00') -> 'state' ->> 'send_stop_reason', 'monitoring_failure', 'send reason: monitoring failure');
select is(pg_temp.resume('2026-11-09 11:05+00', 'send'), 'no_check_after_stop', 'no automatic or immediate resume after the failure');

select is((pg_temp.rec('2026-11-09 11:35+00', '2026-11-09 11:30+00') ->> 'valid')::boolean, true, 'c9 (Nov 9 11:30) valid');
select is((pg_temp.rec('2026-11-10 11:35+00', '2026-11-10 11:30+00') ->> 'valid')::boolean, true, 'c10 (Nov 10 11:30) valid');
select is(pg_temp.resume('2026-11-10 11:40+00', 'send'), 'ok', 'sending resumed after two checks 24 h apart');
select is(pg_temp.resume('2026-11-10 11:40+00', 'registration'), 'ok', 'registrations resumed');

-- ============================================================
-- Manual stop: immediate, no automatic resume
-- ============================================================

select isnt(pg_temp.stop('2026-11-10 12:00+00'), null, 'manual stop at Nov 10 12:00');
select is(pg_temp.flags('2026-11-10 12:00+00'), 'reg=0 tc=0 send=0 grace=0', 'manual stop: everything stops at once, no grace');
select is((pg_temp.at('2026-11-10 12:00+00') -> 'state' ->> 'send_stop_reason') || '/' || (pg_temp.at('2026-11-10 12:00+00') -> 'state' ->> 'registration_stop_reason'), 'manual_stop/manual_stop', 'reason: manual stop for both');
select is((pg_temp.at('2026-11-10 12:00+00') -> 'state' ->> 'manual_stop_active')::boolean, true, 'manual stop shown as active');
select is((pg_temp.rec('2026-11-10 12:35+00', '2026-11-10 12:30+00') ->> 'valid')::boolean, true, 'c11 (Nov 10 12:30) valid');
select is(pg_temp.flags('2026-11-10 12:40+00'), 'reg=0 tc=0 send=0 grace=0', 'a valid check after a manual stop reopens nothing');
select is(pg_temp.resume('2026-11-10 12:40+00', 'send'), 'second_check_missing', 'one check after the manual stop is not enough');
select is((pg_temp.rec('2026-11-11 12:35+00', '2026-11-11 12:30+00') ->> 'valid')::boolean, true, 'c12 (Nov 11 12:30) valid');
select is(pg_temp.resume('2026-11-11 12:40+00', 'send'), 'ok', 'sending resumed by the admin');
select is(pg_temp.resume('2026-11-11 12:40+00', 'registration'), 'ok', 'registrations resumed by the admin');
select is((pg_temp.at('2026-11-11 12:40+00') -> 'state' ->> 'manual_stop_active')::boolean, false, 'manual stop no longer active');

-- ============================================================
-- Invalid check: a monitoring failure; voiding it reopens nothing
-- ============================================================

insert into ids select 'c13', (pg_temp.rec('2026-11-11 13:05+00', '2026-11-11 13:00+00', null, 'off') ->> 'check_id')::uuid;
select is((select count(*)::int from ids), 1, 'c13 (spend cap off) stored as invalid');
select is(pg_temp.flags('2026-11-11 13:05+00'), 'reg=0 tc=0 send=1 grace=1', 'invalid check: registrations stop, sending in grace');
select is(pg_temp.at('2026-11-11 13:05+00') -> 'state' ->> 'registration_stop_reason', 'invalid_check', 'reason: invalid check');
select lives_ok($$select pg_temp.void('2026-11-11 13:10+00', (select id from ids where name = 'c13'))$$, 'c13 voided');
select is(pg_temp.flags('2026-11-11 13:10+00'), 'reg=0 tc=0 send=1 grace=1', 'voiding the invalid check reopens nothing');
select throws_ok($$select pg_temp.void('2026-11-11 13:15+00', (select id from ids where name = 'c13'))$$, 'P0002', null, 'voiding twice is refused');
select throws_ok($$select pg_temp.void('2026-11-11 13:15+00', gen_random_uuid())$$, 'P0002', null, 'voiding an unknown check is refused');
select throws_ok($$select public.admin_void_p6_usage_check((select id from ids where name = 'c13'), 'other', 1)$$, 'P0409', null, 'voiding from a stale page is refused');
select throws_ok($$select public.admin_void_p6_usage_check((select id from ids where name = 'c13'), 'because', (pg_temp.at('2026-11-11 13:15+00') -> 'state' ->> 'version')::bigint)$$, '22023', null, 'a free-text void reason is refused');
select is(pg_temp.flags('2026-11-11 14:05+00'), 'reg=0 tc=0 send=0 grace=0', 'sending stops 1 hour after the invalid check');
select is((pg_temp.rec('2026-11-11 14:35+00', '2026-11-11 14:30+00') ->> 'valid')::boolean, true, 'c14 (Nov 11 14:30) valid (the voided c13 is ignored)');
select is((pg_temp.rec('2026-11-12 14:35+00', '2026-11-12 14:30+00') ->> 'valid')::boolean, true, 'c15 (Nov 12 14:30) valid');
select is(pg_temp.resume('2026-11-12 14:40+00', 'send'), 'ok', 'sending resumed');
select is(pg_temp.resume('2026-11-12 14:40+00', 'registration'), 'ok', 'registrations resumed');

-- ============================================================
-- 90% stops registrations only; 95% stops sending at once
-- ============================================================

select is((pg_temp.rec('2026-11-12 15:05+00', '2026-11-12 15:00+00', pg_temp.egress('225')) ->> 'valid')::boolean, true, 'c16: egress 225 GB (90.000%) valid');
select is(pg_temp.flags('2026-11-12 15:05+00'), 'reg=0 tc=1 send=1 grace=0', '90%: registrations stop; sending and token changes go on');
select is(pg_temp.at('2026-11-12 15:05+00') -> 'state' ->> 'registration_stop_reason', 'usage_90', 'reason: 90%');
select is(pg_temp.resume('2026-11-12 15:10+00', 'send'), 'not_stopped', 'sending is not stopped by 90%');
select is((pg_temp.rec('2026-11-12 16:05+00', '2026-11-12 16:00+00', pg_temp.egress('237.4975')) ->> 'valid')::boolean, true, 'c17: egress 94.999% valid');
select is(pg_temp.flags('2026-11-12 16:05+00'), 'reg=0 tc=1 send=1 grace=0', '94.999%: sending goes on');
select is((pg_temp.rec('2026-11-12 17:05+00', '2026-11-12 17:00+00', pg_temp.egress('237.5')) ->> 'valid')::boolean, true, 'c18: egress 237.5 GB (95.000%) valid');
select is(pg_temp.flags('2026-11-12 17:05+00'), 'reg=0 tc=0 send=0 grace=0', '95%: sending stops at once, no grace');
select is(pg_temp.flags('2026-11-12 17:04:59.999999+00'), 'reg=0 tc=1 send=1 grace=0', 'just before c18 was recorded: still sending');
select is(pg_temp.at('2026-11-12 17:05+00') -> 'state' ->> 'send_stop_reason', 'usage_95', 'send reason: 95%');
select is(pg_temp.reasons(pg_temp.pre('2026-11-12 17:15+00', '2026-11-12 17:10+00', pg_temp.egress('0'))), 'usage_decreased', 'cumulative usage going down in the same period is invalid');
select is(pg_temp.reasons(pg_temp.pre('2026-11-12 17:15+00', '2026-11-12 17:10+00', pg_temp.vals(jsonb_build_object('egress', '{"metric":"egress","status":"measured","value":"237.5","unit":"GB","quota":"250"}'::jsonb, 'disk_size_preview', '{"metric":"disk_size_preview","status":"measured","value":"1","unit":"GB","quota":"8"}'::jsonb)))), 'usage_decreased', 'provisioned disk going down is invalid');
select is((pg_temp.rec('2026-11-13 17:05+00', '2026-11-13 17:00+00', pg_temp.egress('237.5')) ->> 'valid')::boolean, true, 'c19 (24 h after c18, still 95%) valid');
select is((pg_temp.rec('2026-11-14 17:05+00', '2026-11-14 17:00+00', pg_temp.egress('237.5')) ->> 'valid')::boolean, true, 'c20 (still 95%) valid');
select is(pg_temp.resume('2026-11-14 17:10+00', 'send'), 'usage_too_high', 'two valid checks at 95% do not resume sending');
select is(pg_temp.resume('2026-11-14 17:10+00', 'registration'), 'usage_too_high', 'nor registrations');
select is(pg_temp.flags('2026-11-14 17:10+00'), 'reg=0 tc=0 send=0 grace=0', 'still stopped');

reset role;

-- ============================================================
-- Warnings, audit and version consistency
-- ============================================================

select is((select string_agg(level::text, ',' order by level) from private.p6_warnings where kind = 'usage' and metric_code = 'egress'), '60,80,90,95', 'egress warned once per level in the period, repeated readings add none');
select is((select count(*)::int from private.p6_warnings where kind = 'usage' and metric_code <> 'egress'), 0, 'no warning for metrics below 60%');
select is((select count(*)::int from private.p6_warnings where kind = 'monitoring'), 4, 'one monitoring warning per failure (3) and per invalid check (1)');
select is((select count(*)::int from private.p6_admin_events where action = 'record_check'), (select count(*)::int from private.p6_usage_checks), 'one record_check event per stored check');
select ok((select bool_and(actor = '00000000-0000-4000-8000-0000000060a1') from private.p6_admin_events), 'every event names the admin');
select is((select version from private.p6_control), 1 + (select count(*) from private.p6_admin_events where action <> 'resume_refused'), 'the version moved once per write (refused resumes change nothing)');
select is((select string_agg(code, ',' order by id) from private.p6_admin_events where action = 'resume_refused'), 'second_check_missing,not_stopped,no_check_after_stop,second_check_missing,failure_between_checks,no_check_after_stop,second_check_missing,not_stopped,usage_too_high,usage_too_high', 'refused resumes are audited with their reason');
select is((select count(*)::int from private.p6_check_voids), 1, 'one void row; the voided check is kept');
select is((select count(*)::int from private.p6_usage_checks where not is_valid), 1, 'one invalid check stored');

-- ============================================================
-- Append-only
-- ============================================================

select throws_ok($$update private.p6_usage_checks set spend_cap = 'on'$$, '55000', null, 'checks cannot be updated');
select throws_ok($$delete from private.p6_usage_values$$, '55000', null, 'values cannot be deleted');
select throws_ok($$delete from private.p6_check_voids$$, '55000', null, 'voids cannot be deleted');
select throws_ok($$update private.p6_monitoring_failures set kind = 'other'$$, '55000', null, 'failures cannot be updated');
select throws_ok($$delete from private.p6_manual_stops$$, '55000', null, 'manual stops cannot be deleted');
select throws_ok($$truncate private.p6_admin_events$$, '55000', null, 'the audit cannot be truncated');
select throws_ok($$delete from private.p6_warnings$$, '55000', null, 'warnings cannot be deleted');
select throws_ok($$update private.p6_metrics set quota = 1000$$, '55000', null, 'metric quotas cannot be updated');
select throws_ok($$delete from private.p6_control$$, '55000', null, 'the control row cannot be deleted');

-- The gates are still closed after all of the above.
select ok(not private.push_registration_intake_open() and not private.push_token_change_open(), 'both gates still closed');

select * from finish();
rollback;
