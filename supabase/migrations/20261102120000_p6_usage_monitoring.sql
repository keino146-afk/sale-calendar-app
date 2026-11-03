-- Supabase usage monitoring core (roadmap 3, P6).
--
-- An admin reads the official Supabase dashboard about once a day and
-- records what it shows: eleven metrics, the billing period and the spend
-- cap. From that history the database works out, on demand and at its own
-- clock, whether new push registrations, token-change confirmations and
-- push sending would be allowed:
--   60%  watch          (shown only)
--   80%  warning        (shown in the admin screen)
--   90%  new registrations stop
--   95%  push sending stops
-- A check older than 29 hours stops registrations and one older than 30
-- hours stops sending. A monitoring failure (recorded failure, invalid
-- check, expired check, no check) stops registrations at once; sending may
-- go on for at most one hour after it, and only while the last valid check
-- is still in force; a later check or failure never extends that hour.
-- 95% known or a manual stop stops sending at once.
--
-- Stops latch. Registrations and sending each have their own resume time
-- (the start of their current "epoch"); any stop condition met since then
-- keeps that target stopped until an admin resumes it, which needs two
-- valid checks made after the stop and at least 24 hours apart, nothing
-- wrong in between, and the usage below the target's threshold. Nothing
-- reopens by itself. Before the first resume both are stopped.
--
-- Billing period (P1): a check is in force at most until the earliest
-- possible end of its period (end date 00:00 at UTC+14); the dashboard's
-- time zone is not known. Limited P2 is not implemented.
--
-- THIS MIGRATION CONNECTS NOTHING. private.push_registration_intake_open()
-- and private.push_token_change_open() are not touched and still return
-- false; no push RPC, worker or edge function reads private.p6_state().
-- Connecting it needs a later, separately approved migration.
--
-- Unknown values are never 0: a metric the admin could not read makes the
-- check invalid, and an invalid check is a monitoring failure. Thresholds
-- are compared exactly in numeric (usage * 100 >= quota * level), never in
-- floating point. Byte metrics are stored in GB; MB and KB are divided by
-- 1000 (decimal). If the dashboard meant binary units, decimal conversion
-- gives the larger GB value, so it never under-states usage.
--
-- Storage Size is the billing-period average the dashboard shows, not the
-- current size, and is used only as that average.
--
-- History tables are append-only (UPDATE, DELETE and TRUNCATE raise
-- 55000); a wrong check is voided by a separate row, never changed. Every
-- table is in schema private with RLS on, no policy and no client grant.
-- Admins use the SECURITY DEFINER RPCs below, which check
-- private.is_admin() first. Every write RPC locks the single control row
-- (FOR UPDATE) before anything else, so admin writes run one at a time.
--
-- Warnings are stored once per billing period, metric and level (and once
-- per failure or invalid check) whether or not any email exists; delivery
-- state, if email is adopted later, belongs in a separate table that
-- references p6_warnings and is never read by the stop logic.
--
-- Errors: 42501 not an admin; 22023 malformed input (nothing stored);
-- P0409 the page was stale (version changed, or the check's validity
-- differs from the one confirmed); P0002 no such check, or already voided;
-- 23505 a check with the same dashboard time already exists.

-- ============================================================
-- Helpers (not callable by clients)
-- ============================================================

-- The time every P6 RPC uses, taken once the control row is locked. It
-- exists so tests can fix the time inside a rolled-back transaction.
create function private.p6_current_time()
returns timestamptz
language sql
volatile
set search_path = ''
as $$ select pg_catalog.clock_timestamp() $$;

-- 0, 60, 80, 90 or 95, compared exactly (no division, no rounding).
create function private.p6_level(p_usage numeric, p_quota numeric)
returns smallint
language sql
immutable
set search_path = ''
as $$
  select (case
    when p_usage * 100 >= p_quota * 95 then 95
    when p_usage * 100 >= p_quota * 90 then 90
    when p_usage * 100 >= p_quota * 80 then 80
    when p_usage * 100 >= p_quota * 60 then 60
    else 0
  end)::smallint
$$;

-- Earliest instant the period can start / end, whatever the dashboard's
-- time zone: the date's 00:00 at UTC+14. A check must be made after the
-- latest possible start (00:00 at UTC-12) and is in force only until the
-- earliest possible end.
create function private.p6_period_earliest(p_date date)
returns timestamptz
language sql
immutable
set search_path = ''
as $$ select (p_date::timestamp at time zone 'UTC') - interval '14 hours' $$;

create function private.p6_period_latest(p_date date)
returns timestamptz
language sql
immutable
set search_path = ''
as $$ select (p_date::timestamp at time zone 'UTC') + interval '12 hours' $$;

-- ============================================================
-- Tables
-- ============================================================

-- The eleven required metrics. Changed only by migrations.
create table private.p6_metrics (
  code text primary key,
  sort_order smallint not null unique,
  scope text not null,
  project text null,
  kind text not null,
  unit_kind text not null,
  -- GB for bytes, a plain count otherwise (Pro plan, 2026-11-02).
  quota numeric not null,
  constraint p6_metrics_code_format check (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint p6_metrics_scope_valid check (scope in ('organization', 'project')),
  constraint p6_metrics_project_valid check (project in ('preview', 'production')),
  constraint p6_metrics_scope_project check ((scope = 'organization') = (project is null)),
  constraint p6_metrics_kind_valid check (kind in ('cumulative', 'peak', 'average', 'provisioned')),
  constraint p6_metrics_unit_kind_valid check (unit_kind in ('bytes', 'count')),
  constraint p6_metrics_quota_positive check (quota > 0)
);

insert into private.p6_metrics (code, sort_order, scope, project, kind, unit_kind, quota) values
  ('egress',                    1,  'organization', null,         'cumulative',  'bytes', 250),
  ('cached_egress',             2,  'organization', null,         'cumulative',  'bytes', 250),
  ('edge_function_invocations', 3,  'organization', null,         'cumulative',  'count', 2000000),
  ('monthly_active_users',      4,  'organization', null,         'cumulative',  'count', 100000),
  ('storage_size',              5,  'organization', null,         'average',     'bytes', 100),
  ('realtime_messages',         6,  'organization', null,         'cumulative',  'count', 5000000),
  ('realtime_peak_connections', 7,  'organization', null,         'peak',        'count', 500),
  ('log_ingestion',             8,  'organization', null,         'cumulative',  'bytes', 20),
  ('log_query',                 9,  'organization', null,         'cumulative',  'bytes', 2000),
  ('disk_size_preview',         10, 'project',      'preview',    'provisioned', 'bytes', 8),
  ('disk_size_production',      11, 'project',      'production', 'provisioned', 'bytes', 8);

-- One reading of the dashboard. Valid only when every rule held at the
-- time it was recorded; otherwise invalid_reasons says why, and the check
-- counts as a monitoring failure.
create table private.p6_usage_checks (
  id uuid primary key default gen_random_uuid(),
  -- When the admin read the dashboard (entered).
  checked_at timestamptz not null,
  -- When the database stored it (database clock).
  recorded_at timestamptz not null,
  period_start date not null,
  period_end date not null,
  spend_cap text not null,
  -- The data time the dashboard showed, if it showed one.
  data_as_of timestamptz null,
  is_valid boolean not null,
  invalid_reasons text[] not null,
  recorded_by uuid not null,
  constraint p6_usage_checks_spend_cap_valid check (spend_cap in ('on', 'off', 'unknown')),
  constraint p6_usage_checks_reasons check (is_valid = (cardinality(invalid_reasons) = 0))
);

create index p6_usage_checks_recorded_at_idx on private.p6_usage_checks (recorded_at);
create index p6_usage_checks_checked_at_idx on private.p6_usage_checks (checked_at);

-- One row per metric per check. usage is in GB (bytes) or a count.
create table private.p6_usage_values (
  check_id uuid not null references private.p6_usage_checks (id) on delete restrict,
  metric_code text not null references private.p6_metrics (code) on delete restrict,
  status text not null,
  entered_value numeric null,
  entered_unit text null,
  usage numeric null,
  entered_quota numeric null,
  level smallint null,
  primary key (check_id, metric_code),
  constraint p6_usage_values_status_valid check (status in ('measured', 'unavailable')),
  constraint p6_usage_values_unit_valid check (entered_unit in ('GB', 'MB', 'KB', 'count')),
  constraint p6_usage_values_level_valid check (level in (0, 60, 80, 90, 95)),
  constraint p6_usage_values_fields check (
    (status = 'measured'
      and entered_value >= 0 and entered_unit is not null and usage >= 0
      and entered_quota >= 0 and level is not null)
    or
    (status = 'unavailable'
      and entered_value is null and entered_unit is null and usage is null
      and entered_quota is null and level is null)
  )
);

-- A check found to be wrong. The check and its values stay.
create table private.p6_check_voids (
  check_id uuid primary key references private.p6_usage_checks (id) on delete restrict,
  reason text not null,
  voided_at timestamptz not null,
  voided_by uuid not null,
  constraint p6_check_voids_reason_valid check (reason in ('input_error', 'wrong_period', 'other'))
);

create table private.p6_monitoring_failures (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  recorded_at timestamptz not null,
  recorded_by uuid not null,
  constraint p6_monitoring_failures_kind_valid check (
    kind in ('dashboard_unavailable', 'usage_unreadable', 'other')
  )
);

create index p6_monitoring_failures_recorded_at_idx on private.p6_monitoring_failures (recorded_at);

create table private.p6_manual_stops (
  id uuid primary key default gen_random_uuid(),
  reason text not null,
  stopped_at timestamptz not null,
  stopped_by uuid not null,
  constraint p6_manual_stops_reason_valid check (reason in ('usage_concern', 'monitoring_concern', 'other'))
);

create index p6_manual_stops_stopped_at_idx on private.p6_manual_stops (stopped_at);

-- The single control row. version changes on every admin write, so a page
-- can tell it is stale. A null resume time means never resumed (stopped).
create table private.p6_control (
  id smallint primary key default 1,
  version bigint not null default 1,
  registration_resumed_at timestamptz null,
  send_resumed_at timestamptz null,
  updated_at timestamptz not null default now(),
  constraint p6_control_singleton check (id = 1),
  constraint p6_control_version_positive check (version >= 1)
);

insert into private.p6_control (id) values (1);

-- Audit of every admin write (codes only, no free text).
create table private.p6_admin_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null,
  actor uuid not null,
  action text not null,
  check_id uuid null references private.p6_usage_checks (id) on delete restrict,
  failure_id uuid null references private.p6_monitoring_failures (id) on delete restrict,
  stop_id uuid null references private.p6_manual_stops (id) on delete restrict,
  target text null,
  code text null,
  version_after bigint not null,
  constraint p6_admin_events_action_valid check (
    action in ('record_check', 'void_check', 'record_failure', 'manual_stop', 'resume', 'resume_refused')
  ),
  constraint p6_admin_events_target_valid check (target in ('registration', 'send')),
  constraint p6_admin_events_code_format check (code ~ '^[a-z][a-z0-9_]{0,63}$')
);

-- Warnings shown in the admin screen, independent of any email.
create table private.p6_warnings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null,
  kind text not null,
  level smallint null,
  metric_code text null references private.p6_metrics (code) on delete restrict,
  period_start date null,
  check_id uuid null references private.p6_usage_checks (id) on delete restrict,
  failure_id uuid null references private.p6_monitoring_failures (id) on delete restrict,
  constraint p6_warnings_kind_valid check (kind in ('usage', 'monitoring')),
  constraint p6_warnings_level_valid check (level in (60, 80, 90, 95)),
  constraint p6_warnings_fields check (
    (kind = 'usage'
      and level is not null and metric_code is not null and period_start is not null
      and check_id is not null and failure_id is null)
    or
    (kind = 'monitoring'
      and level is null and metric_code is null and period_start is null
      and (check_id is null) <> (failure_id is null))
  )
);

create unique index p6_warnings_usage_uidx
  on private.p6_warnings (period_start, metric_code, level) where kind = 'usage';
create unique index p6_warnings_monitoring_check_uidx
  on private.p6_warnings (check_id) where kind = 'monitoring' and check_id is not null;
create unique index p6_warnings_monitoring_failure_uidx
  on private.p6_warnings (failure_id) where kind = 'monitoring' and failure_id is not null;

-- ============================================================
-- Append-only guards
-- ============================================================

create function private.p6_reject_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'P6 history is append-only (%)', tg_table_name using errcode = '55000';
end;
$$;

create trigger p6_metrics_append_only
  before update or delete on private.p6_metrics
  for each row execute function private.p6_reject_change();
create trigger p6_metrics_no_truncate
  before truncate on private.p6_metrics
  for each statement execute function private.p6_reject_change();

create trigger p6_usage_checks_append_only
  before update or delete on private.p6_usage_checks
  for each row execute function private.p6_reject_change();
create trigger p6_usage_checks_no_truncate
  before truncate on private.p6_usage_checks
  for each statement execute function private.p6_reject_change();

create trigger p6_usage_values_append_only
  before update or delete on private.p6_usage_values
  for each row execute function private.p6_reject_change();
create trigger p6_usage_values_no_truncate
  before truncate on private.p6_usage_values
  for each statement execute function private.p6_reject_change();

create trigger p6_check_voids_append_only
  before update or delete on private.p6_check_voids
  for each row execute function private.p6_reject_change();
create trigger p6_check_voids_no_truncate
  before truncate on private.p6_check_voids
  for each statement execute function private.p6_reject_change();

create trigger p6_monitoring_failures_append_only
  before update or delete on private.p6_monitoring_failures
  for each row execute function private.p6_reject_change();
create trigger p6_monitoring_failures_no_truncate
  before truncate on private.p6_monitoring_failures
  for each statement execute function private.p6_reject_change();

create trigger p6_manual_stops_append_only
  before update or delete on private.p6_manual_stops
  for each row execute function private.p6_reject_change();
create trigger p6_manual_stops_no_truncate
  before truncate on private.p6_manual_stops
  for each statement execute function private.p6_reject_change();

create trigger p6_admin_events_append_only
  before update or delete on private.p6_admin_events
  for each row execute function private.p6_reject_change();
create trigger p6_admin_events_no_truncate
  before truncate on private.p6_admin_events
  for each statement execute function private.p6_reject_change();

create trigger p6_warnings_append_only
  before update or delete on private.p6_warnings
  for each row execute function private.p6_reject_change();
create trigger p6_warnings_no_truncate
  before truncate on private.p6_warnings
  for each statement execute function private.p6_reject_change();

-- The control row is updated, never deleted.
create trigger p6_control_no_delete
  before delete on private.p6_control
  for each row execute function private.p6_reject_change();
create trigger p6_control_no_truncate
  before truncate on private.p6_control
  for each statement execute function private.p6_reject_change();

-- ============================================================
-- Evaluation (not callable by clients)
-- ============================================================

-- When a valid check stops being in force (sending) and 1 hour before
-- (registrations): 30 hours after it was read, or the earliest possible end
-- of its billing period if sooner.
create function private.p6_check_expires_at(p_checked_at timestamptz, p_period_end date)
returns timestamptz
language sql
immutable
set search_path = ''
as $$ select least(p_checked_at + interval '30 hours', private.p6_period_earliest(p_period_end)) $$;

create function private.p6_check_deadline(p_checked_at timestamptz, p_period_end date)
returns timestamptz
language sql
immutable
set search_path = ''
as $$ select private.p6_check_expires_at(p_checked_at, p_period_end) - interval '1 hour' $$;

-- One target since its epoch (resume time). Returns when it stops (may be
-- in the future, or -infinity when never resumed), why, and the first
-- monitoring failure with the end of its grace hour.
--   p_threshold 90 (registrations) or 95 (sending)
--   p_grace     false: a monitoring failure stops at once (registrations)
--               true:  it stops at the end of the grace hour (sending)
-- Voided checks: still count for thresholds and as failures when invalid
-- (a correction never reopens anything), but never as the valid check in
-- force.
create function private.p6_target_eval(
  p_epoch timestamptz,
  p_threshold smallint,
  p_grace boolean
)
returns table (stop_at timestamptz, stop_reason text, incident_at timestamptz, grace_until timestamptz)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_a private.p6_usage_checks%rowtype;
  v_n private.p6_usage_checks%rowtype;
  v_manual timestamptz;
  v_threshold timestamptz;
  v_exp_at timestamptz;
  v_exp_until timestamptz;
  v_exp_reason text;
  v_fail timestamptz;
  v_invalid timestamptz;
  v_event timestamptz;
  v_event_until timestamptz;
  v_event_reason text;
  v_incident timestamptz;
  v_until timestamptz;
  v_incident_reason text;
  v_monitoring_stop timestamptz;
  v_stop timestamptz;
begin
  if p_epoch is null then
    return query select '-infinity'::timestamptz, 'not_started'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  select pg_catalog.min(m.stopped_at) into v_manual
  from private.p6_manual_stops m
  where m.stopped_at >= p_epoch;

  select pg_catalog.min(c.recorded_at) into v_threshold
  from private.p6_usage_checks c
  where c.recorded_at >= p_epoch
    and exists (
      select 1 from private.p6_usage_values v
      where v.check_id = c.id and v.level >= p_threshold
    );

  -- The valid check in force at the epoch, then each later one that came
  -- before the previous one's deadline.
  select c.* into v_a
  from private.p6_usage_checks c
  where c.is_valid
    and c.recorded_at <= p_epoch
    and not exists (select 1 from private.p6_check_voids x where x.check_id = c.id)
  order by c.recorded_at desc
  limit 1;

  if not found then
    v_exp_at := p_epoch;
    v_exp_until := p_epoch;
    v_exp_reason := 'no_measurement';
  else
    for v_n in
      select c.*
      from private.p6_usage_checks c
      where c.is_valid
        and c.recorded_at > p_epoch
        and not exists (select 1 from private.p6_check_voids x where x.check_id = c.id)
      order by c.recorded_at
    loop
      exit when v_n.recorded_at >= private.p6_check_deadline(v_a.checked_at, v_a.period_end);
      v_a := v_n;
    end loop;
    v_exp_at := greatest(private.p6_check_deadline(v_a.checked_at, v_a.period_end), p_epoch);
    v_exp_until := least(v_exp_at + interval '1 hour', private.p6_check_expires_at(v_a.checked_at, v_a.period_end));
    v_exp_reason := 'expired';
  end if;

  -- The first recorded failure or invalid check since the epoch. The grace
  -- runs from it, bounded by the valid check in force at that time.
  select pg_catalog.min(f.recorded_at) into v_fail
  from private.p6_monitoring_failures f
  where f.recorded_at >= p_epoch;

  select pg_catalog.min(c.recorded_at) into v_invalid
  from private.p6_usage_checks c
  where not c.is_valid and c.recorded_at >= p_epoch;

  v_event := least(v_fail, v_invalid);
  if v_event is not null then
    v_event_reason := case when v_event = v_fail then 'monitoring_failure' else 'invalid_check' end;
    select c.* into v_n
    from private.p6_usage_checks c
    where c.is_valid
      and c.recorded_at <= v_event
      and not exists (select 1 from private.p6_check_voids x where x.check_id = c.id)
    order by c.recorded_at desc
    limit 1;
    if found then
      v_event_until := least(v_event + interval '1 hour', private.p6_check_expires_at(v_n.checked_at, v_n.period_end));
    else
      v_event_until := v_event;
    end if;
  end if;

  if v_event is not null and v_event < v_exp_at then
    v_incident := v_event;
    v_incident_reason := v_event_reason;
  else
    v_incident := v_exp_at;
    v_incident_reason := v_exp_reason;
  end if;
  v_until := least(v_exp_until, v_event_until);

  v_monitoring_stop := case when p_grace then v_until else v_incident end;
  v_stop := least(v_manual, v_threshold, v_monitoring_stop);

  return query select
    v_stop,
    case
      when v_stop = v_manual then 'manual_stop'
      when v_stop = v_threshold then case when p_threshold = 95 then 'usage_95' else 'usage_90' end
      else v_incident_reason
    end,
    v_incident,
    v_until;
end;
$$;

-- The P6 state at p_now. For a later, approved gate migration:
--   registration_allowed  -> new registrations
--   token_change_allowed  -> token-change confirmations
--   sends_allowed         -> automatic push sending (worker, U6/U7)
-- Nothing calls it for that yet.
create function private.p6_state(p_now timestamptz)
returns table (
  evaluated_at timestamptz,
  registration_allowed boolean,
  token_change_allowed boolean,
  sends_allowed boolean,
  send_in_grace boolean,
  registration_stop_at timestamptz,
  registration_stop_reason text,
  send_stop_at timestamptz,
  send_stop_reason text,
  monitoring_incident_at timestamptz,
  send_grace_until timestamptz,
  registration_resumed_at timestamptz,
  send_resumed_at timestamptz,
  current_check_id uuid,
  current_check_registration_deadline timestamptz,
  current_check_send_deadline timestamptz,
  current_max_level smallint,
  manual_stop_active boolean,
  version bigint
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_control private.p6_control%rowtype;
  v_reg record;
  v_send record;
  v_reg_open boolean;
  v_send_open boolean;
  v_grace boolean;
  v_current private.p6_usage_checks%rowtype;
  v_level smallint;
  v_last_manual timestamptz;
begin
  if p_now is null then
    raise exception 'missing time' using errcode = '22023';
  end if;

  select * into v_control from private.p6_control where id = 1;

  select * into v_reg from private.p6_target_eval(v_control.registration_resumed_at, 90::smallint, false);
  select * into v_send from private.p6_target_eval(v_control.send_resumed_at, 95::smallint, true);

  v_reg_open := v_reg.stop_at > p_now;
  v_send_open := v_send.stop_at > p_now;
  v_grace := v_send_open and v_send.incident_at <= p_now;

  select c.* into v_current
  from private.p6_usage_checks c
  where c.is_valid
    and not exists (select 1 from private.p6_check_voids x where x.check_id = c.id)
  order by c.recorded_at desc
  limit 1;

  if found then
    select pg_catalog.max(v.level) into v_level
    from private.p6_usage_values v where v.check_id = v_current.id;
  end if;

  select pg_catalog.max(m.stopped_at) into v_last_manual from private.p6_manual_stops m;

  return query select
    p_now,
    v_reg_open and v_send_open and not v_grace,
    v_send_open and not v_grace,
    v_send_open,
    v_grace,
    v_reg.stop_at,
    v_reg.stop_reason,
    v_send.stop_at,
    v_send.stop_reason,
    v_send.incident_at,
    v_send.grace_until,
    v_control.registration_resumed_at,
    v_control.send_resumed_at,
    v_current.id,
    case when v_current.id is null then null else private.p6_check_deadline(v_current.checked_at, v_current.period_end) end,
    case when v_current.id is null then null else private.p6_check_expires_at(v_current.checked_at, v_current.period_end) end,
    v_level,
    v_last_manual is not null
      and (v_control.registration_resumed_at is null or v_last_manual >= v_control.registration_resumed_at
        or v_control.send_resumed_at is null or v_last_manual >= v_control.send_resumed_at),
    v_control.version;
end;
$$;

-- Why p_target may not be resumed at p_now, or null when it may:
--   not_stopped               the target is not stopped
--   no_valid_check            no valid check at all
--   no_check_after_stop       the latest valid check was not read and
--                             recorded after the stop
--   check_expired             the latest valid check is past its deadline
--   second_check_missing      no earlier valid check read after the stop
--                             and at least 24 hours before the latest
--   failure_between_checks    a failure was recorded since the earlier one
--   invalid_between_checks    an invalid check was recorded since then
--   gap_between_checks        valid checks since then were not continuous
--   usage_too_high            a value since then reached the threshold
create function private.p6_resume_refusal(p_target text, p_now timestamptz)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_control private.p6_control%rowtype;
  v_epoch timestamptz;
  v_threshold smallint;
  v_eval record;
  v_after timestamptz;
  v_m1 private.p6_usage_checks%rowtype;
  v_m2 private.p6_usage_checks%rowtype;
  v_prev private.p6_usage_checks%rowtype;
  v_c private.p6_usage_checks%rowtype;
  v_first boolean := true;
begin
  if p_target is null or p_target not in ('registration', 'send') or p_now is null then
    raise exception 'invalid target' using errcode = '22023';
  end if;

  select * into v_control from private.p6_control where id = 1;
  v_epoch := case when p_target = 'registration' then v_control.registration_resumed_at else v_control.send_resumed_at end;
  v_threshold := case when p_target = 'registration' then 90 else 95 end;

  select * into v_eval from private.p6_target_eval(v_epoch, v_threshold, p_target = 'send');
  if v_eval.stop_at > p_now then
    return 'not_stopped';
  end if;

  -- Both checks must be read and recorded after the stop and after the
  -- latest manual stop.
  v_after := greatest(
    v_eval.stop_at,
    coalesce((select pg_catalog.max(m.stopped_at) from private.p6_manual_stops m), '-infinity'::timestamptz)
  );

  select c.* into v_m2
  from private.p6_usage_checks c
  where c.is_valid
    and not exists (select 1 from private.p6_check_voids x where x.check_id = c.id)
  order by c.recorded_at desc
  limit 1;
  if not found then
    return 'no_valid_check';
  end if;
  if not (v_m2.checked_at > v_after and v_m2.recorded_at > v_after) then
    return 'no_check_after_stop';
  end if;
  if p_now >= private.p6_check_deadline(v_m2.checked_at, v_m2.period_end) then
    return 'check_expired';
  end if;

  select c.* into v_m1
  from private.p6_usage_checks c
  where c.is_valid
    and not exists (select 1 from private.p6_check_voids x where x.check_id = c.id)
    and c.checked_at <= v_m2.checked_at - interval '24 hours'
    and c.checked_at > v_after
    and c.recorded_at > v_after
  order by c.checked_at desc
  limit 1;
  if not found then
    return 'second_check_missing';
  end if;

  if exists (select 1 from private.p6_monitoring_failures f where f.recorded_at >= v_m1.recorded_at) then
    return 'failure_between_checks';
  end if;
  if exists (select 1 from private.p6_usage_checks c where not c.is_valid and c.recorded_at >= v_m1.recorded_at) then
    return 'invalid_between_checks';
  end if;

  for v_c in
    select c.*
    from private.p6_usage_checks c
    where c.is_valid
      and not exists (select 1 from private.p6_check_voids x where x.check_id = c.id)
      and c.recorded_at >= v_m1.recorded_at
      and c.recorded_at <= v_m2.recorded_at
    order by c.recorded_at
  loop
    if not v_first and v_c.recorded_at >= private.p6_check_deadline(v_prev.checked_at, v_prev.period_end) then
      return 'gap_between_checks';
    end if;
    v_prev := v_c;
    v_first := false;
  end loop;

  if exists (
    select 1
    from private.p6_usage_checks c
    join private.p6_usage_values v on v.check_id = c.id
    where c.recorded_at >= v_m1.recorded_at and v.level >= v_threshold
  ) then
    return 'usage_too_high';
  end if;

  return null;
end;
$$;

-- ============================================================
-- RPC: record (or only validate) a dashboard check
-- ============================================================

-- p_values: a JSON array with exactly one object per metric:
--   {"metric": code, "status": "measured", "value": "0.008", "unit": "GB", "quota": "250"}
--   {"metric": code, "status": "unavailable"}
-- Numbers are decimal strings. Units: GB, MB or KB for byte metrics, count
-- otherwise (integers only). Malformed input raises 22023 and stores
-- nothing. A well-formed check that breaks a rule is stored as invalid.
--
-- p_commit false only validates (nothing is stored or locked). p_commit
-- true needs the version the page was loaded with and the validity it
-- showed; if either differs now, P0409 and nothing is stored.
create function public.admin_record_p6_usage_check(
  p_checked_at timestamptz,
  p_period_start date,
  p_period_end date,
  p_spend_cap text,
  p_data_as_of timestamptz,
  p_values jsonb,
  p_commit boolean,
  p_expected_version bigint,
  p_expected_valid boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number constant text := '^[0-9]{1,15}(\.[0-9]{1,9})?$';
  v_integer constant text := '^[0-9]{1,15}$';
  v_version bigint;
  v_now timestamptz;
  v_item jsonb;
  v_metric private.p6_metrics%rowtype;
  v_seen text[] := '{}';
  v_rows jsonb := '[]';
  v_status text;
  v_value numeric;
  v_unit text;
  v_quota numeric;
  v_usage numeric;
  v_level smallint;
  v_unavailable boolean := false;
  v_quota_mismatch boolean := false;
  v_decreased boolean := false;
  v_reasons text[] := '{}';
  v_prev private.p6_usage_checks%rowtype;
  v_prev_valid private.p6_usage_checks%rowtype;
  v_has_prev_valid boolean;
  v_prev_usage numeric;
  v_valid boolean;
  v_id uuid;
  v_row jsonb;
begin
  if not private.is_admin() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  if p_checked_at is null or p_period_start is null or p_period_end is null
    or p_spend_cap is null or p_values is null or p_commit is null
    or (p_commit and (p_expected_version is null or p_expected_valid is null)) then
    raise exception 'missing field' using errcode = '22023';
  end if;
  if p_spend_cap not in ('on', 'off', 'unknown') then
    raise exception 'invalid spend cap' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_values) <> 'array'
    or pg_catalog.jsonb_array_length(p_values) <> (select pg_catalog.count(*) from private.p6_metrics) then
    raise exception 'values must list every metric once' using errcode = '22023';
  end if;
  if p_period_end <= p_period_start then
    raise exception 'invalid billing period' using errcode = '22023';
  end if;

  -- Writes are serialized on the control row; a validation only reads.
  if p_commit then
    select c.version into v_version from private.p6_control c where c.id = 1 for update;
    if v_version <> p_expected_version then
      raise exception 'P6 state changed since it was loaded' using errcode = 'P0409';
    end if;
  else
    select c.version into v_version from private.p6_control c where c.id = 1;
  end if;

  v_now := private.p6_current_time();

  -- Shape of every value first.
  for v_item in select e from pg_catalog.jsonb_array_elements(p_values) e loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object' then
      raise exception 'invalid value entry' using errcode = '22023';
    end if;
    select * into v_metric from private.p6_metrics m where m.code = v_item ->> 'metric';
    if not found or v_metric.code = any (v_seen) then
      raise exception 'unknown or repeated metric' using errcode = '22023';
    end if;
    v_seen := v_seen || v_metric.code;
    v_status := v_item ->> 'status';
    if v_status = 'unavailable' then
      if (v_item - 'metric' - 'status') <> '{}'::jsonb then
        raise exception 'unavailable metric with a value' using errcode = '22023';
      end if;
      v_unavailable := true;
      v_rows := v_rows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'metric', v_metric.code, 'status', 'unavailable'));
      continue;
    end if;
    if v_status is distinct from 'measured'
      or (v_item - 'metric' - 'status' - 'value' - 'unit' - 'quota') <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(v_item -> 'value') is distinct from 'string'
      or pg_catalog.jsonb_typeof(v_item -> 'unit') is distinct from 'string'
      or pg_catalog.jsonb_typeof(v_item -> 'quota') is distinct from 'string' then
      raise exception 'invalid value entry' using errcode = '22023';
    end if;
    v_unit := v_item ->> 'unit';
    if (v_metric.unit_kind = 'bytes' and v_unit not in ('GB', 'MB', 'KB'))
      or (v_metric.unit_kind = 'count' and v_unit <> 'count') then
      raise exception 'invalid unit' using errcode = '22023';
    end if;
    if (v_item ->> 'value') !~ (case when v_unit = 'count' then v_integer else v_number end)
      or (v_item ->> 'quota') !~ (case when v_unit = 'count' then v_integer else v_number end) then
      raise exception 'invalid number' using errcode = '22023';
    end if;
    v_value := (v_item ->> 'value')::numeric;
    v_quota := (v_item ->> 'quota')::numeric;
    v_usage := case v_unit
      when 'MB' then v_value / 1000
      when 'KB' then v_value / 1000000
      else v_value
    end;
    v_level := private.p6_level(v_usage, v_metric.quota);
    if v_quota <> v_metric.quota then
      v_quota_mismatch := true;
    end if;
    v_rows := v_rows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'metric', v_metric.code, 'status', 'measured',
      'entered_value', v_value::text, 'entered_unit', v_unit,
      'usage', v_usage::text, 'quota', v_metric.quota::text, 'entered_quota', v_quota::text,
      -- Display only, truncated (never rounded up past a threshold).
      'percent', pg_catalog.trunc(v_usage * 100 / v_metric.quota, 3)::text,
      'level', v_level));
  end loop;

  -- Rules.
  if v_unavailable then v_reasons := v_reasons || 'metric_unavailable'::text; end if;
  if v_quota_mismatch then v_reasons := v_reasons || 'quota_mismatch'::text; end if;
  if p_spend_cap <> 'on' then v_reasons := v_reasons || 'spend_cap_not_on'::text; end if;
  if p_checked_at > v_now then
    v_reasons := v_reasons || 'checked_at_future'::text;
  elsif v_now - p_checked_at > interval '1 hour' then
    v_reasons := v_reasons || 'recorded_too_late'::text;
  end if;

  -- The same dashboard reading sent twice is refused, not stored as a
  -- second (invalid) check.
  if exists (
    select 1 from private.p6_usage_checks c
    where c.checked_at = p_checked_at
      and not exists (select 1 from private.p6_check_voids x where x.check_id = c.id)
  ) then
    raise exception 'a check with this time already exists' using errcode = '23505';
  end if;

  select c.* into v_prev
  from private.p6_usage_checks c
  where not exists (select 1 from private.p6_check_voids x where x.check_id = c.id)
  order by c.checked_at desc
  limit 1;
  if found and p_checked_at <= v_prev.checked_at then
    v_reasons := v_reasons || 'checked_at_not_newer'::text;
  end if;

  if p_period_end - p_period_start not between 27 and 31 then
    v_reasons := v_reasons || 'period_invalid'::text;
  elsif p_checked_at < private.p6_period_latest(p_period_start)
    or p_checked_at >= private.p6_period_earliest(p_period_end) then
    v_reasons := v_reasons || 'period_not_current'::text;
  end if;

  select c.* into v_prev_valid
  from private.p6_usage_checks c
  where c.is_valid
    and not exists (select 1 from private.p6_check_voids x where x.check_id = c.id)
  order by c.recorded_at desc
  limit 1;
  v_has_prev_valid := found;

  if v_has_prev_valid then
    if not ((p_period_start = v_prev_valid.period_start and p_period_end = v_prev_valid.period_end)
      or p_period_start in (v_prev_valid.period_end, v_prev_valid.period_end + 1)) then
      v_reasons := v_reasons || 'period_mismatch'::text;
    end if;

    -- Values that cannot go down: cumulative and peak within the same
    -- period, provisioned disk at any time.
    for v_row in select e from pg_catalog.jsonb_array_elements(v_rows) e where e ->> 'status' = 'measured' loop
      select * into v_metric from private.p6_metrics m where m.code = v_row ->> 'metric';
      if v_metric.kind = 'provisioned'
        or (v_metric.kind in ('cumulative', 'peak') and p_period_start = v_prev_valid.period_start) then
        select v.usage into v_prev_usage
        from private.p6_usage_values v
        where v.check_id = v_prev_valid.id and v.metric_code = v_metric.code;
        if v_prev_usage is not null and (v_row ->> 'usage')::numeric < v_prev_usage then
          v_decreased := true;
        end if;
      end if;
    end loop;
    if v_decreased then v_reasons := v_reasons || 'usage_decreased'::text; end if;
  end if;

  if p_data_as_of is not null then
    if p_data_as_of > p_checked_at then
      v_reasons := v_reasons || 'data_as_of_future'::text;
    elsif p_data_as_of < private.p6_period_earliest(p_period_start)
      or (v_has_prev_valid and v_prev_valid.data_as_of is not null and p_data_as_of < v_prev_valid.data_as_of) then
      v_reasons := v_reasons || 'data_stale'::text;
    end if;
  end if;

  v_valid := cardinality(v_reasons) = 0;

  if not p_commit then
    return pg_catalog.jsonb_build_object(
      'committed', false, 'valid', v_valid, 'reasons', pg_catalog.to_jsonb(v_reasons),
      'values', v_rows, 'evaluated_at', v_now, 'version', v_version);
  end if;

  if v_valid <> p_expected_valid then
    raise exception 'check validity changed since it was shown' using errcode = 'P0409';
  end if;

  insert into private.p6_usage_checks
    (checked_at, recorded_at, period_start, period_end, spend_cap, data_as_of, is_valid, invalid_reasons, recorded_by)
  values
    (p_checked_at, v_now, p_period_start, p_period_end, p_spend_cap, p_data_as_of, v_valid, v_reasons, (select auth.uid()))
  returning id into v_id;

  insert into private.p6_usage_values
    (check_id, metric_code, status, entered_value, entered_unit, usage, entered_quota, level)
  select v_id, e ->> 'metric', e ->> 'status',
         (e ->> 'entered_value')::numeric, e ->> 'entered_unit', (e ->> 'usage')::numeric,
         (e ->> 'entered_quota')::numeric, (e ->> 'level')::smallint
  from pg_catalog.jsonb_array_elements(v_rows) e;

  -- Usage warnings (valid or not: a high value is never ignored), once per
  -- billing period, metric and level.
  insert into private.p6_warnings (created_at, kind, level, metric_code, period_start, check_id)
  select v_now, 'usage', l.level, v.metric_code, p_period_start, v_id
  from private.p6_usage_values v
  join (values (60::smallint), (80::smallint), (90::smallint), (95::smallint)) l(level) on v.level >= l.level
  where v.check_id = v_id
  on conflict (period_start, metric_code, level) where kind = 'usage' do nothing;

  if not v_valid then
    insert into private.p6_warnings (created_at, kind, check_id) values (v_now, 'monitoring', v_id);
  end if;

  update private.p6_control c set version = c.version + 1, updated_at = v_now where c.id = 1
  returning c.version into v_version;

  insert into private.p6_admin_events (occurred_at, actor, action, check_id, code, version_after)
  values (v_now, (select auth.uid()), 'record_check', v_id, case when v_valid then 'valid' else 'invalid' end, v_version);

  return pg_catalog.jsonb_build_object(
    'committed', true, 'check_id', v_id, 'valid', v_valid, 'reasons', pg_catalog.to_jsonb(v_reasons),
    'values', v_rows, 'evaluated_at', v_now, 'version', v_version);
end;
$$;

-- ============================================================
-- RPC: void a check (the check stays; it is no longer the check in force)
-- ============================================================

create function public.admin_void_p6_usage_check(p_check_id uuid, p_reason text, p_expected_version bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version bigint;
  v_now timestamptz;
begin
  if not private.is_admin() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if p_check_id is null or p_expected_version is null
    or p_reason is null or p_reason not in ('input_error', 'wrong_period', 'other') then
    raise exception 'missing or invalid field' using errcode = '22023';
  end if;

  select c.version into v_version from private.p6_control c where c.id = 1 for update;
  if v_version <> p_expected_version then
    raise exception 'P6 state changed since it was loaded' using errcode = 'P0409';
  end if;
  v_now := private.p6_current_time();

  if not exists (select 1 from private.p6_usage_checks c where c.id = p_check_id)
    or exists (select 1 from private.p6_check_voids x where x.check_id = p_check_id) then
    raise exception 'check not found or already voided' using errcode = 'P0002';
  end if;

  insert into private.p6_check_voids (check_id, reason, voided_at, voided_by)
  values (p_check_id, p_reason, v_now, (select auth.uid()));

  update private.p6_control c set version = c.version + 1, updated_at = v_now where c.id = 1
  returning c.version into v_version;

  insert into private.p6_admin_events (occurred_at, actor, action, check_id, code, version_after)
  values (v_now, (select auth.uid()), 'void_check', p_check_id, p_reason, v_version);
end;
$$;

-- ============================================================
-- RPC: record a monitoring failure (safe side: no version check)
-- ============================================================

create function public.admin_record_p6_monitoring_failure(p_kind text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version bigint;
  v_now timestamptz;
  v_id uuid;
begin
  if not private.is_admin() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('dashboard_unavailable', 'usage_unreadable', 'other') then
    raise exception 'invalid failure kind' using errcode = '22023';
  end if;

  perform 1 from private.p6_control c where c.id = 1 for update;
  v_now := private.p6_current_time();

  insert into private.p6_monitoring_failures (kind, recorded_at, recorded_by)
  values (p_kind, v_now, (select auth.uid()))
  returning id into v_id;

  insert into private.p6_warnings (created_at, kind, failure_id) values (v_now, 'monitoring', v_id);

  update private.p6_control c set version = c.version + 1, updated_at = v_now where c.id = 1
  returning c.version into v_version;

  insert into private.p6_admin_events (occurred_at, actor, action, failure_id, code, version_after)
  values (v_now, (select auth.uid()), 'record_failure', v_id, p_kind, v_version);

  return v_id;
end;
$$;

-- ============================================================
-- RPC: manual stop (safe side: no version check, never refused for age)
-- ============================================================

create function public.admin_stop_p6(p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version bigint;
  v_now timestamptz;
  v_id uuid;
begin
  if not private.is_admin() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if p_reason is null or p_reason not in ('usage_concern', 'monitoring_concern', 'other') then
    raise exception 'invalid stop reason' using errcode = '22023';
  end if;

  perform 1 from private.p6_control c where c.id = 1 for update;
  v_now := private.p6_current_time();

  insert into private.p6_manual_stops (reason, stopped_at, stopped_by)
  values (p_reason, v_now, (select auth.uid()))
  returning id into v_id;

  update private.p6_control c set version = c.version + 1, updated_at = v_now where c.id = 1
  returning c.version into v_version;

  insert into private.p6_admin_events (occurred_at, actor, action, stop_id, code, version_after)
  values (v_now, (select auth.uid()), 'manual_stop', v_id, p_reason, v_version);

  return v_id;
end;
$$;

-- ============================================================
-- RPC: resume one target (re-checked under the lock)
-- ============================================================

-- Returns {"ok": true} or {"ok": false, "reason": <p6_resume_refusal code>}.
create function public.admin_resume_p6(p_target text, p_expected_version bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version bigint;
  v_now timestamptz;
  v_refusal text;
begin
  if not private.is_admin() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if p_target is null or p_target not in ('registration', 'send') or p_expected_version is null then
    raise exception 'missing or invalid field' using errcode = '22023';
  end if;

  select c.version into v_version from private.p6_control c where c.id = 1 for update;
  if v_version <> p_expected_version then
    raise exception 'P6 state changed since it was loaded' using errcode = 'P0409';
  end if;
  v_now := private.p6_current_time();

  v_refusal := private.p6_resume_refusal(p_target, v_now);
  if v_refusal is not null then
    insert into private.p6_admin_events (occurred_at, actor, action, target, code, version_after)
    values (v_now, (select auth.uid()), 'resume_refused', p_target, v_refusal, v_version);
    return pg_catalog.jsonb_build_object('ok', false, 'reason', v_refusal);
  end if;

  update private.p6_control c
  set registration_resumed_at = case when p_target = 'registration' then v_now else c.registration_resumed_at end,
      send_resumed_at = case when p_target = 'send' then v_now else c.send_resumed_at end,
      version = c.version + 1,
      updated_at = v_now
  where c.id = 1
  returning c.version into v_version;

  insert into private.p6_admin_events (occurred_at, actor, action, target, version_after)
  values (v_now, (select auth.uid()), 'resume', p_target, v_version);

  return pg_catalog.jsonb_build_object('ok', true);
end;
$$;

-- ============================================================
-- RPC: everything the admin usage page shows (read-only)
-- ============================================================

create function public.admin_get_p6_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_state jsonb;
begin
  if not private.is_admin() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  v_now := private.p6_current_time();
  select pg_catalog.to_jsonb(s) into v_state from private.p6_state(v_now) s;

  return pg_catalog.jsonb_build_object(
    'state', v_state,
    'resume_registration_refusal', private.p6_resume_refusal('registration', v_now),
    'resume_send_refusal', private.p6_resume_refusal('send', v_now),
    'metrics', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'code', m.code, 'scope', m.scope, 'project', m.project, 'kind', m.kind,
        'unit_kind', m.unit_kind, 'quota', m.quota::text) order by m.sort_order), '[]')
      from private.p6_metrics m),
    'checks', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'checked_at', c.checked_at, 'recorded_at', c.recorded_at,
        'period_start', c.period_start, 'period_end', c.period_end, 'spend_cap', c.spend_cap,
        'data_as_of', c.data_as_of, 'is_valid', c.is_valid, 'invalid_reasons', pg_catalog.to_jsonb(c.invalid_reasons),
        'voided_reason', x.reason, 'voided_at', x.voided_at,
        'values', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'metric', v.metric_code, 'status', v.status,
            'entered_value', v.entered_value::text, 'entered_unit', v.entered_unit,
            'usage', v.usage::text, 'level', v.level,
            'percent', case when v.usage is null then null else pg_catalog.trunc(v.usage * 100 / m.quota, 3)::text end
          ) order by m.sort_order), '[]')
          from private.p6_usage_values v join private.p6_metrics m on m.code = v.metric_code
          where v.check_id = c.id)
      ) order by c.recorded_at desc), '[]')
      from (select * from private.p6_usage_checks order by recorded_at desc limit 30) c
      left join private.p6_check_voids x on x.check_id = c.id),
    'failures', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', f.id, 'kind', f.kind, 'recorded_at', f.recorded_at) order by f.recorded_at desc), '[]')
      from (select * from private.p6_monitoring_failures order by recorded_at desc limit 30) f),
    'manual_stops', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', s.id, 'reason', s.reason, 'stopped_at', s.stopped_at) order by s.stopped_at desc), '[]')
      from (select * from private.p6_manual_stops order by stopped_at desc limit 10) s),
    'warnings', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', w.id, 'created_at', w.created_at, 'kind', w.kind, 'level', w.level,
        'metric', w.metric_code, 'period_start', w.period_start) order by w.created_at desc), '[]')
      from (select * from private.p6_warnings order by created_at desc limit 50) w)
  );
end;
$$;

-- ============================================================
-- Grants
-- ============================================================

alter table private.p6_metrics enable row level security;
alter table private.p6_usage_checks enable row level security;
alter table private.p6_usage_values enable row level security;
alter table private.p6_check_voids enable row level security;
alter table private.p6_monitoring_failures enable row level security;
alter table private.p6_manual_stops enable row level security;
alter table private.p6_control enable row level security;
alter table private.p6_admin_events enable row level security;
alter table private.p6_warnings enable row level security;

revoke all on table
  private.p6_metrics, private.p6_usage_checks, private.p6_usage_values, private.p6_check_voids,
  private.p6_monitoring_failures, private.p6_manual_stops, private.p6_control,
  private.p6_admin_events, private.p6_warnings
  from public, anon, authenticated, service_role;
revoke all on sequence private.p6_admin_events_id_seq from public, anon, authenticated, service_role;

revoke all on function private.p6_current_time() from public, anon, authenticated, service_role;
revoke all on function private.p6_level(numeric, numeric) from public, anon, authenticated, service_role;
revoke all on function private.p6_period_earliest(date) from public, anon, authenticated, service_role;
revoke all on function private.p6_period_latest(date) from public, anon, authenticated, service_role;
revoke all on function private.p6_reject_change() from public, anon, authenticated, service_role;
revoke all on function private.p6_check_expires_at(timestamptz, date) from public, anon, authenticated, service_role;
revoke all on function private.p6_check_deadline(timestamptz, date) from public, anon, authenticated, service_role;
revoke all on function private.p6_target_eval(timestamptz, smallint, boolean) from public, anon, authenticated, service_role;
revoke all on function private.p6_state(timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.p6_resume_refusal(text, timestamptz) from public, anon, authenticated, service_role;

revoke all on function public.admin_record_p6_usage_check(timestamptz, date, date, text, timestamptz, jsonb, boolean, bigint, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_void_p6_usage_check(uuid, text, bigint) from public, anon, authenticated, service_role;
revoke all on function public.admin_record_p6_monitoring_failure(text) from public, anon, authenticated, service_role;
revoke all on function public.admin_stop_p6(text) from public, anon, authenticated, service_role;
revoke all on function public.admin_resume_p6(text, bigint) from public, anon, authenticated, service_role;
revoke all on function public.admin_get_p6_status() from public, anon, authenticated, service_role;

-- Admins only: authenticated may call them, and each checks is_admin() first.
grant execute on function public.admin_record_p6_usage_check(timestamptz, date, date, text, timestamptz, jsonb, boolean, bigint, boolean)
  to authenticated;
grant execute on function public.admin_void_p6_usage_check(uuid, text, bigint) to authenticated;
grant execute on function public.admin_record_p6_monitoring_failure(text) to authenticated;
grant execute on function public.admin_stop_p6(text) to authenticated;
grant execute on function public.admin_resume_p6(text, bigint) to authenticated;
grant execute on function public.admin_get_p6_status() to authenticated;
