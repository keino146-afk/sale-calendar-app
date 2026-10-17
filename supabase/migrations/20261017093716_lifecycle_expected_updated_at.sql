-- Stale-view protection for the lifecycle RPCs (Phase 6O).
--
-- Each lifecycle RPC gets an overload with one more argument,
-- p_expected_updated_at: the updated_at the admin's page was rendered with.
-- Under a row lock the new overloads check, in this order:
--   - admins only (checked first, inside the function);
--   - the sale exists and is in the status the transition starts from
--     (otherwise P0002, as in the original functions);
--   - the sale has not changed since the page was loaded (otherwise P0409);
-- and only then change the status. A transition therefore never applies to
-- content the admin has not seen, and the check cannot race a concurrent
-- save or transition.
--
-- The original one-argument (two for reject) functions are kept unchanged so
-- that an older application deployment keeps working against this schema
-- (migration first, then application; rollback of the application only).
-- p_expected_updated_at has no default, so PostgREST resolves the old and the
-- new overload unambiguously by the argument names sent.
--
-- Stale is reported with the application-specific SQLSTATE P0409, never
-- 40001: PostgREST treats 40001 (serialization_failure) as retryable and
-- re-runs the whole transaction until its timeout, so a stale request would
-- spin for about a minute and end in a 504. public.update_sale_event used
-- 40001 for the same purpose; it is re-created below with P0409 and
-- otherwise unchanged.
--
-- Errors (codes only are mapped by the application):
--   42501 not an admin
--   22023 missing field, or an invalid reject reason
--   P0002 sale not found or not in the required status
--   P0409 the sale changed since the caller loaded it (stale)
--   23505 duplicate active sale (reopen only, sale_events_active_dedup_uidx)

-- ============================================================
-- publish: pending_review -> published
-- ============================================================

create function public.publish_sale_event(p_id uuid, p_expected_updated_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale public.sale_events%rowtype;
begin
  if not private.is_admin() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  if p_id is null or p_expected_updated_at is null then
    raise exception 'missing field' using errcode = '22023';
  end if;

  select * into v_sale
  from public.sale_events
  where id = p_id
  for update;
  if not found or v_sale.status <> 'pending_review' then
    raise exception 'sale event not found or not pending_review' using errcode = 'P0002';
  end if;
  if v_sale.updated_at is distinct from p_expected_updated_at then
    raise exception 'sale event changed since it was loaded' using errcode = 'P0409';
  end if;

  perform pg_catalog.set_config('app.audit_note', '', true);

  update public.sale_events
  set status = 'published'
  where id = p_id;
end;
$$;

-- ============================================================
-- reject: pending_review -> rejected (reason in the audit note)
-- ============================================================

create function public.reject_sale_event(p_id uuid, p_reason text, p_expected_updated_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale public.sale_events%rowtype;
  v_reason text;
begin
  if not private.is_admin() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  if p_id is null or p_expected_updated_at is null then
    raise exception 'missing field' using errcode = '22023';
  end if;

  -- Same normalisation and limits as reject_sale_event(uuid, text).
  v_reason := normalize(p_reason, NFKC);
  v_reason := pg_catalog.regexp_replace(v_reason, '^[[:space:]]+', '');
  v_reason := pg_catalog.regexp_replace(v_reason, '[[:space:]]+$', '');

  if v_reason is null or v_reason = '' then
    raise exception 'reject reason is required' using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_reason) > 2000 then
    raise exception 'reject reason must be 2000 characters or fewer' using errcode = '22023';
  end if;

  select * into v_sale
  from public.sale_events
  where id = p_id
  for update;
  if not found or v_sale.status <> 'pending_review' then
    raise exception 'sale event not found or not pending_review' using errcode = 'P0002';
  end if;
  if v_sale.updated_at is distinct from p_expected_updated_at then
    raise exception 'sale event changed since it was loaded' using errcode = 'P0409';
  end if;

  perform pg_catalog.set_config('app.audit_note', v_reason, true);

  update public.sale_events
  set status = 'rejected'
  where id = p_id;
end;
$$;

-- ============================================================
-- archive: published -> archived
-- ============================================================

create function public.archive_sale_event(p_id uuid, p_expected_updated_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale public.sale_events%rowtype;
begin
  if not private.is_admin() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  if p_id is null or p_expected_updated_at is null then
    raise exception 'missing field' using errcode = '22023';
  end if;

  select * into v_sale
  from public.sale_events
  where id = p_id
  for update;
  if not found or v_sale.status <> 'published' then
    raise exception 'sale event not found or not published' using errcode = 'P0002';
  end if;
  if v_sale.updated_at is distinct from p_expected_updated_at then
    raise exception 'sale event changed since it was loaded' using errcode = 'P0409';
  end if;

  perform pg_catalog.set_config('app.audit_note', '', true);

  update public.sale_events
  set status = 'archived'
  where id = p_id;
end;
$$;

-- ============================================================
-- reopen: rejected -> pending_review
-- ============================================================

-- A duplicate active event makes this fail with 23505 by design.
create function public.reopen_sale_event(p_id uuid, p_expected_updated_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale public.sale_events%rowtype;
begin
  if not private.is_admin() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  if p_id is null or p_expected_updated_at is null then
    raise exception 'missing field' using errcode = '22023';
  end if;

  select * into v_sale
  from public.sale_events
  where id = p_id
  for update;
  if not found or v_sale.status <> 'rejected' then
    raise exception 'sale event not found or not rejected' using errcode = 'P0002';
  end if;
  if v_sale.updated_at is distinct from p_expected_updated_at then
    raise exception 'sale event changed since it was loaded' using errcode = 'P0409';
  end if;

  perform pg_catalog.set_config('app.audit_note', '', true);

  update public.sale_events
  set status = 'pending_review'
  where id = p_id;
end;
$$;

-- ============================================================
-- update_sale_event: stale is P0409 instead of 40001
-- ============================================================

-- Same signature and body as in 20261014130235_admin_sale_editing.sql; the
-- only change is the SQLSTATE for "changed since it was loaded". create or
-- replace keeps the function's existing privileges; they are restated below.
create or replace function public.update_sale_event(
  p_id uuid,
  p_expected_updated_at timestamptz,
  p_published_confirmed boolean,
  p_title text,
  p_description text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_is_date_only boolean,
  p_source_url text,
  p_source_checked_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale public.sale_events%rowtype;
begin
  if not private.is_admin() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  if p_id is null or p_expected_updated_at is null then
    raise exception 'missing field' using errcode = '22023';
  end if;

  -- Lock first: a concurrent save or lifecycle change of the same sale waits
  -- here and then sees the new updated_at.
  select * into v_sale
  from public.sale_events
  where id = p_id
  for update;
  if not found then
    raise exception 'sale event not found' using errcode = 'P0002';
  end if;
  if v_sale.status not in ('pending_review', 'published', 'rejected') then
    raise exception 'sale event is not editable' using errcode = '55000';
  end if;
  if v_sale.updated_at is distinct from p_expected_updated_at then
    raise exception 'sale event changed since it was loaded' using errcode = 'P0409';
  end if;
  if v_sale.status = 'published' and p_published_confirmed is not true then
    raise exception 'published sale requires confirmation' using errcode = '22023';
  end if;

  perform private.assert_valid_sale_content(
    v_sale.retailer_id, p_title, p_description, p_starts_at, p_ends_at,
    p_is_date_only, p_source_url, p_source_checked_at
  );

  -- A new source URL needs a newer confirmation time than the old one.
  if p_source_url is distinct from v_sale.source_url
     and v_sale.source_checked_at is not null
     and p_source_checked_at <= v_sale.source_checked_at then
    raise exception 'new source url needs a newer checked time' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('app.audit_note', '', true);

  -- retailer_id, status and system columns are never set here.
  update public.sale_events
  set title = p_title,
      description = p_description,
      starts_at = p_starts_at,
      ends_at = p_ends_at,
      is_date_only = p_is_date_only,
      source_url = p_source_url,
      source_checked_at = p_source_checked_at
  where id = p_id;
end;
$$;

revoke all on function public.update_sale_event(
  uuid, timestamptz, boolean, text, text, timestamptz, timestamptz, boolean, text, timestamptz
) from public, anon;
grant execute on function public.update_sale_event(
  uuid, timestamptz, boolean, text, text, timestamptz, timestamptz, boolean, text, timestamptz
) to authenticated;

-- ============================================================
-- Privileges (functions are executable by PUBLIC by default)
-- ============================================================

revoke all on function public.publish_sale_event(uuid, timestamptz) from public, anon;
revoke all on function public.reject_sale_event(uuid, text, timestamptz) from public, anon;
revoke all on function public.archive_sale_event(uuid, timestamptz) from public, anon;
revoke all on function public.reopen_sale_event(uuid, timestamptz) from public, anon;

grant execute on function public.publish_sale_event(uuid, timestamptz) to authenticated;
grant execute on function public.reject_sale_event(uuid, text, timestamptz) to authenticated;
grant execute on function public.archive_sale_event(uuid, timestamptz) to authenticated;
grant execute on function public.reopen_sale_event(uuid, timestamptz) to authenticated;
