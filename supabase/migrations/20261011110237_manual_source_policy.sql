-- Approved official announcement sources for manual registration (Phase 5C-1.5).
--
-- A sale's source URL is normally on the retailer's own official domain
-- (retailers.official_base_url). Some retailers announce sales on a separate
-- official site instead (Amazon: www.aboutamazon.jp). Such a site is allowed
-- as a manual source through private.collection_sources:
--
--   allow_manual_source  admins may cite matching URLs when registering a sale
--   enabled              a collector may submit candidates from the source
--
-- The two are independent. The aboutamazon source below is allowed for
-- manual registration only; it stays disabled for collection.

alter table private.collection_sources
  add column allow_manual_source boolean not null default false;

-- Exact host only, https only, no credentials, port, query or fragment, and
-- only news article paths (/news/<category>/<slug>), as observed on the
-- official site.
insert into private.collection_sources (
  id, retailer_id, expected_host, source_url_pattern, enabled, allow_manual_source
)
select
  'amazon-aboutamazon-news',
  r.id,
  'www.aboutamazon.jp',
  '^https://www\.aboutamazon\.jp/news/[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*$',
  false,
  true
from public.retailers r
where r.slug = 'amazon';

do $$
begin
  if (select count(*) from private.collection_sources where id = 'amazon-aboutamazon-news') <> 1 then
    raise exception 'amazon retailer not found';
  end if;
end;
$$;

-- ============================================================
-- Manual source check (admins only)
-- ============================================================

-- True when the URL is on an approved announcement source for the retailer.
-- The retailer's own official domain is checked by the application and is
-- not part of this policy. enabled is ignored here: it only governs
-- collectors. Any doubt returns false (fail closed).
create function public.is_allowed_manual_source(
  p_retailer_id uuid,
  p_hostname text,
  p_source_url text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_host text;
begin
  if not private.is_admin() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  if p_retailer_id is null or p_hostname is null or p_source_url is null
     or pg_catalog.char_length(p_source_url) > 2048 then
    return false;
  end if;

  -- The host the caller parsed must be the host actually in the URL.
  v_host := pg_catalog.lower(pg_catalog.substring(p_source_url, '^https://([^/?#]*)'));
  if v_host is null or v_host is distinct from p_hostname then
    return false;
  end if;

  return exists (
    select 1
    from private.collection_sources s
    where s.allow_manual_source
      and s.retailer_id = p_retailer_id
      and s.expected_host = v_host
      and p_source_url ~ s.source_url_pattern
  );
end;
$$;

revoke all on function public.is_allowed_manual_source(uuid, text, text) from public, anon;
grant execute on function public.is_allowed_manual_source(uuid, text, text) to authenticated;
