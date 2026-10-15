-- Admin-only editing of a registered sale's content (Phase 6F).
--
-- public.update_sale_event is the only way to change a sale's content:
--   - admins only (checked first, inside the function);
--   - pending_review, published and rejected sales; archived sales stay
--     immutable (also enforced by the existing transition trigger);
--   - exactly seven content columns: title, description, starts_at, ends_at,
--     is_date_only, source_url, source_checked_at. The retailer, the status
--     and every system column are never changed here;
--   - optimistic concurrency: the caller passes the updated_at it last saw,
--     and the save is refused if the row changed since;
--   - a published sale is changed only with an explicit confirmation;
--   - every value is re-validated here, independently of the application.
-- The existing audit trigger records the change as 'update' with the admin
-- as actor (auth.uid() is the caller's, also inside SECURITY DEFINER).
--
-- The direct UPDATE privilege of authenticated on sale_events is revoked, so
-- even an admin cannot change a row except through the functions. The
-- sale_events_admin_update RLS policy is kept as a second layer.

-- ============================================================
-- Content validation (used by update_sale_event)
-- ============================================================

-- Raises 22023 when the content is not acceptable for the retailer. Same
-- rules as public.import_collection_candidate, except that the retailer may
-- be inactive (an existing sale's content can still be corrected), and that
-- date-only periods must start and end at midnight JST.
create function private.assert_valid_sale_content(
  p_retailer_id uuid,
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
stable
set search_path = ''
as $$
declare
  v_official_base_url text;
  v_host text;
  v_base text;
  v_min timestamptz := '2020-01-01 00:00:00+09';
  v_max timestamptz := '2101-01-01 00:00:00+09';
begin
  if p_retailer_id is null or p_title is null or p_starts_at is null or p_ends_at is null
     or p_is_date_only is null or p_source_url is null or p_source_checked_at is null then
    raise exception 'missing field' using errcode = '22023';
  end if;
  select official_base_url into v_official_base_url
  from public.retailers
  where id = p_retailer_id;
  if not found then
    raise exception 'retailer not found' using errcode = '22023';
  end if;
  if pg_catalog.char_length(pg_catalog.regexp_replace(normalize(p_title, NFKC), '[[:space:]]+', '', 'g'))
       not between 1 and 200 then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_description is not null and pg_catalog.char_length(p_description) > 5000 then
    raise exception 'invalid description' using errcode = '22023';
  end if;
  if p_ends_at <= p_starts_at or p_starts_at < v_min or p_ends_at > v_max
     or p_source_checked_at < v_min or p_source_checked_at >= v_max then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  if p_is_date_only
     and ((p_starts_at at time zone 'Asia/Tokyo')::time <> '00:00'
          or (p_ends_at at time zone 'Asia/Tokyo')::time <> '00:00') then
    raise exception 'date-only period must start and end at midnight' using errcode = '22023';
  end if;

  -- https only; no credentials, explicit port, whitespace or control chars.
  if pg_catalog.char_length(p_source_url) > 2048
     or p_source_url !~ '^https://[^/?#@:]+([/?#]|$)'
     or p_source_url ~ '[[:space:][:cntrl:]]' then
    raise exception 'invalid source url' using errcode = '22023';
  end if;

  -- The retailer's official domain (its host without a leading "www." or a
  -- subdomain of it), or an approved manual source for the retailer.
  v_host := pg_catalog.lower(pg_catalog.substring(p_source_url, '^https://([^/?#]*)'));
  v_base := pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.substring(v_official_base_url, '^https://([^/?#:]*)')), '^www\.', '');
  if v_base is null or v_base = '' then
    raise exception 'retailer has no official domain' using errcode = '22023';
  end if;
  if not (v_host = v_base or pg_catalog.right(v_host, pg_catalog.char_length(v_base) + 1) = '.' || v_base)
     and not public.is_allowed_manual_source(p_retailer_id, v_host, p_source_url) then
    raise exception 'source url not allowed for retailer' using errcode = '22023';
  end if;
end;
$$;

revoke all on function private.assert_valid_sale_content(
  uuid, text, text, timestamptz, timestamptz, boolean, text, timestamptz
) from public, anon, authenticated;

-- ============================================================
-- Admin-only content update
-- ============================================================

-- Errors (codes only are mapped by the application):
--   42501 not an admin
--   P0002 sale not found
--   55000 sale is archived (not editable)
--   40001 the sale changed since the caller loaded it (stale)
--   22023 invalid input, missing published confirmation, or a new source
--         URL without a newer checked time
--   23505 duplicate active sale (sale_events_active_dedup_uidx)
create function public.update_sale_event(
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
    raise exception 'sale event changed since it was loaded' using errcode = '40001';
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
-- No direct UPDATE from clients
-- ============================================================

-- Content changes go through update_sale_event, status changes through the
-- lifecycle functions; both run as the function owner and do not need this.
revoke update (
  retailer_id,
  title,
  description,
  starts_at,
  ends_at,
  is_date_only,
  source_url,
  source_checked_at
) on table public.sale_events from authenticated;
revoke update on table public.sale_events from authenticated;
