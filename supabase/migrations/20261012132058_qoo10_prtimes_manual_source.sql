-- eBay Japan press releases on PR TIMES as a manual source for Qoo10 (Phase 6B).
--
-- eBay Japan (Qoo10's operator) announces Qoo10 Mega sales on PR TIMES, a
-- third-party press release platform. An admin who has read such a release
-- may cite it as the official source when registering a Qoo10 sale by hand.
-- PR TIMES hosts every company's releases, so the publisher is identified by
-- eBay Japan's company id in the article URL (000022933), not by the host.
--
-- Manual registration only: enabled stays false, so no collector may submit
-- candidates from this source. Live collection of PR TIMES / Qoo10 remains
-- blocked pending permission (see src/collector/sources/qoo10-press/adapter.ts).

-- Exact host only, https only, no credentials, port, query or fragment, and
-- only eBay Japan article paths (/main/html/rd/p/<release>.000022933.html).
-- Same rule as QOO10_PRESS_SOURCE.sourceUrlPattern in the offline adapter.
insert into private.collection_sources (
  id, retailer_id, expected_host, source_url_pattern, enabled, allow_manual_source
)
select
  'qoo10-ebay-japan-press',
  r.id,
  'prtimes.jp',
  '^https://prtimes\.jp/main/html/rd/p/[0-9]{9}\.000022933\.html$',
  false,
  true
from public.retailers r
where r.slug = 'qoo10';

do $$
begin
  if (select count(*) from private.collection_sources where id = 'qoo10-ebay-japan-press') <> 1 then
    raise exception 'qoo10 retailer not found';
  end if;
end;
$$;
