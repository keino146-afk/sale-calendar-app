-- P6 STEP A (roadmap 3, P6): a dashboard reading whose data time is clearly
-- stale is not a normal check.
--
-- public.admin_record_p6_usage_check is replaced with the same signature,
-- return value, SECURITY DEFINER, empty search_path and admin check as in
-- 20261102120000_p6_usage_monitoring.sql. The only change is one more
-- invalid reason:
--
--   data_too_old  p_data_as_of is not null and
--                 p_checked_at - p_data_as_of >= 24 hours
--
-- 24 hours is the bound the Human approved for "clearly stale"; it is not a
-- proof that newer data is fresh. A check without a data time is not
-- checked for age (the dashboard does not always show one, and a time is
-- never guessed). Like every other reason, data_too_old makes the check
-- invalid: it is stored and audited as invalid, counts as a monitoring
-- incident (registrations stop at once, sending gets at most the existing
-- non-extendable 1-hour grace) and can never be one of the two checks a
-- resume needs. Expiry (29 / 30 hours from checked_at), thresholds, the P1
-- billing-period boundary and the resume rules are unchanged. Nothing else
-- is touched: no table, no other function, and the two push intake gates
-- still return false.

create or replace function public.admin_record_p6_usage_check(
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
    -- Clearly stale: the data time shown is 24 hours or more before the
    -- dashboard was read. Only when the dashboard showed a data time; an
    -- unknown data time is never guessed (and stays unverified).
    if p_data_as_of <= p_checked_at - interval '24 hours' then
      v_reasons := v_reasons || 'data_too_old'::text;
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


-- Same privileges as before: admins only, through authenticated (the
-- function checks private.is_admin() first).
revoke all on function public.admin_record_p6_usage_check(timestamptz, date, date, text, timestamptz, jsonb, boolean, bigint, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_record_p6_usage_check(timestamptz, date, date, text, timestamptz, jsonb, boolean, bigint, boolean)
  to authenticated;
