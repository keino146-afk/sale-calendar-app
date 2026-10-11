-- Atomic import of a collection candidate (Phase 5C-2).
--
-- An admin turns a reviewed candidate into a sale event. In one transaction
-- this function
--   1. locks the candidate and requires review_state = 'new',
--   2. validates the admin's final values (the form may have edited them),
--   3. inserts the sale event (8 content columns only: the status default
--      makes it pending_review, triggers derive title_key / start_date_jst
--      and write the 'create' audit row as the calling admin),
--   4. marks the candidate imported and links the new sale event.
-- Any failure raises, so nothing is left half done. Nothing is published:
-- publishing stays a separate lifecycle RPC. Candidate content columns
-- (title, source, evidence, hashes, source_changed) are never changed.
--
-- Candidates remain without any direct write grant; this function and the
-- collector's submit_collection_candidate are the only write paths.

create function public.import_collection_candidate(
  p_candidate_id uuid,
  p_retailer_id uuid,
  p_title text,
  p_description text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_is_date_only boolean,
  p_source_url text,
  p_source_checked_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.collection_candidates%rowtype;
  v_official_base_url text;
  v_host text;
  v_base text;
  v_sale_id uuid;
  v_min timestamptz := '2020-01-01 00:00:00+09';
  v_max timestamptz := '2101-01-01 00:00:00+09';
begin
  if not private.is_admin() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  -- Lock first: a concurrent import of the same candidate waits here and
  -- then sees it is no longer new.
  select * into v_candidate
  from public.collection_candidates
  where id = p_candidate_id
  for update;
  if not found then
    raise exception 'candidate not found' using errcode = 'P0002';
  end if;
  if v_candidate.review_state <> 'new' or v_candidate.imported_sale_event_id is not null then
    raise exception 'candidate is not importable' using errcode = '55000';
  end if;

  -- Final values (never trusted, even when prefilled from the candidate).
  if p_retailer_id is null or p_title is null or p_starts_at is null or p_ends_at is null
     or p_is_date_only is null or p_source_url is null or p_source_checked_at is null then
    raise exception 'missing field' using errcode = '22023';
  end if;
  if p_retailer_id is distinct from v_candidate.retailer_id then
    raise exception 'retailer does not match candidate' using errcode = '22023';
  end if;
  select official_base_url into v_official_base_url
  from public.retailers
  where id = p_retailer_id and is_active;
  if not found then
    raise exception 'retailer not found or inactive' using errcode = '22023';
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

  -- status, timestamps and derived columns are never set here.
  insert into public.sale_events (
    retailer_id, title, description, starts_at, ends_at, is_date_only, source_url, source_checked_at
  ) values (
    p_retailer_id, p_title, p_description, p_starts_at, p_ends_at, p_is_date_only, p_source_url, p_source_checked_at
  )
  returning id into v_sale_id;

  update public.collection_candidates
  set review_state = 'imported',
      imported_sale_event_id = v_sale_id
  where id = p_candidate_id;

  return v_sale_id;
end;
$$;

revoke all on function public.import_collection_candidate(
  uuid, uuid, text, text, timestamptz, timestamptz, boolean, text, timestamptz
) from public, anon;
grant execute on function public.import_collection_candidate(
  uuid, uuid, text, text, timestamptz, timestamptz, boolean, text, timestamptz
) to authenticated;
