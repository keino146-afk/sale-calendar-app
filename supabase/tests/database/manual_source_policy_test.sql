-- pgTAP tests for approved manual announcement sources (Phase 5C-1.5).
-- Everything runs inside one transaction and is rolled back.

begin;

create extension if not exists pgtap with schema extensions;

select plan(52);

-- ============================================================
-- Structure and grants (state right after the migration)
-- ============================================================

select has_column('private', 'collection_sources', 'allow_manual_source', 'collection_sources.allow_manual_source exists');
select col_not_null('private', 'collection_sources', 'allow_manual_source', 'allow_manual_source is not null');
select col_default_is('private', 'collection_sources', 'allow_manual_source', 'false', 'allow_manual_source defaults to false');
select ok(not (select bool_or(has_table_privilege(r, 'private.collection_sources', p)) from unnest(array['anon','authenticated']) r, unnest(array['SELECT','INSERT','UPDATE','DELETE']) p), 'collection_sources stays private');
select ok(not has_schema_privilege('anon', 'private', 'usage'), 'anon has no usage on schema private');
select ok(not has_function_privilege('anon', 'public.is_allowed_manual_source(uuid, text, text)', 'execute') and has_function_privilege('authenticated', 'public.is_allowed_manual_source(uuid, text, text)', 'execute'), 'manual source RPC: authenticated only');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.is_allowed_manual_source(uuid, text, text)'::regprocedure), 'manual source RPC is SECURITY DEFINER with empty search_path');
select is((select count(*)::int from private.collection_sources where id = 'amazon-aboutamazon-news'), 1, 'aboutamazon source policy exists once');
select is((select row(retailer_id = (select id from public.retailers where slug = 'amazon'), expected_host, enabled, allow_manual_source)::text from private.collection_sources where id = 'amazon-aboutamazon-news'), row(true, 'www.aboutamazon.jp', false, true)::text, 'aboutamazon: Amazon retailer, exact host, manual only, collection disabled');
select is((select count(*)::int from private.collection_sources where enabled), 0, 'no source is enabled for collection');
select is((select count(*)::int from private.collector_users) + (select count(*)::int from public.collection_candidates), 0, 'no collector or candidate is created');
select ok(not has_column_privilege('authenticated', 'public.sale_events', 'status', 'INSERT') and not has_column_privilege('authenticated', 'public.sale_events', 'status', 'UPDATE'), 'sale status is still not writable by clients');
select ok(not (select bool_or(has_table_privilege('anon', 'public.sale_events', p)) from unnest(array['INSERT','UPDATE','DELETE']) p), 'anon still cannot write sale_events');

-- ============================================================
-- Fixtures (owner context)
-- ============================================================

insert into auth.users (id, email, aud, role)
values
  ('00000000-0000-4000-8000-0000000d0a01', 'policy-admin@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000d0b01', 'policy-user@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000d0c01', 'policy-collector@example.invalid', 'authenticated', 'authenticated');
insert into public.admin_users (user_id) values ('00000000-0000-4000-8000-0000000d0a01');
insert into private.collector_users (user_id, is_active) values ('00000000-0000-4000-8000-0000000d0c01', true);
-- Same shape as the approved source but not allowed for manual use.
insert into private.collection_sources (id, retailer_id, expected_host, source_url_pattern, enabled, allow_manual_source)
values ('test-not-manual', (select id from public.retailers where slug = 'qoo10'), 'news.example.com',
        '^https://news\.example\.com/[a-z0-9/-]+$', true, false);
create temporary table sale_events_before as select count(*) as n from public.sale_events;
create temporary table ids as
select (select id from public.retailers where slug = 'amazon') as amazon,
       (select id from public.retailers where slug = 'rakuten') as rakuten,
       (select id from public.retailers where slug = 'qoo10') as qoo10;
grant select on ids to anon, authenticated;

-- anon
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok($$select * from private.collection_sources$$, '42501', null, 'anon: source policies unreadable');
select throws_ok($$select public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026')$$, '42501', null, 'anon: manual source RPC denied');
reset role;
-- ordinary authenticated user
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000d0b01","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select * from private.collection_sources$$, '42501', null, 'non-admin: source policies unreadable');
select throws_ok($$select public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026')$$, '42501', null, 'non-admin: manual source RPC denied');
reset role;
-- collector: the aboutamazon source is disabled for collection
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000d0c01","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.submit_collection_candidate('amazon-aboutamazon-news', 'https://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026', (select amazon from ids), 'https://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '55000', null, 'collector: manual-only aboutamazon source rejected (disabled)');
select throws_ok($$select public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026')$$, '42501', null, 'collector: manual source RPC denied (not admin)');
reset role;
-- admin
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000d0a01","role":"authenticated"}', true);
set local role authenticated;
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026'), true, 'admin: approved Amazon article allowed (source disabled for collection)');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/news/company-news/amazon-black-friday-2026'), true, 'admin: another article path allowed');
select is(public.is_allowed_manual_source((select rakuten from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026'), false, 'admin: Rakuten with aboutamazon rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026'), false, 'admin: Qoo10 with aboutamazon rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'aboutamazon.jp', 'https://aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026'), false, 'admin: bare aboutamazon.jp rejected (exact host)');
select is(public.is_allowed_manual_source((select amazon from ids), 'news.aboutamazon.jp', 'https://news.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026'), false, 'admin: other aboutamazon subdomain rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp.evil.example', 'https://www.aboutamazon.jp.evil.example/news/amazon-prime/prime-appreciation-sale-2026'), false, 'admin: evil suffix rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'evil-aboutamazon.jp', 'https://evil-aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026'), false, 'admin: lookalike domain rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.amazon.co.jp', 'https://www.amazon.co.jp/news/amazon-prime/prime-appreciation-sale-2026'), false, 'admin: primary domain is not part of the policy (checked by the app)');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'http://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026'), false, 'admin: http rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://user@www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026'), false, 'admin: credentials rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp:8443/news/amazon-prime/prime-appreciation-sale-2026'), false, 'admin: port rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp:443/news/amazon-prime/prime-appreciation-sale-2026'), false, 'admin: explicit default port rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/other/amazon-prime/prime-appreciation-sale-2026'), false, 'admin: non-news path rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/news'), false, 'admin: news index rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/news/amazon-prime'), false, 'admin: category page rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/rss/feed.rss'), false, 'admin: RSS feed rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026?utm_source=rss'), false, 'admin: query string rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026#top'), false, 'admin: fragment rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026/extra'), false, 'admin: deeper path rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/news/../admin/x'), false, 'admin: dot segments rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://WWW.ABOUTAMAZON.JP/news/amazon-prime/prime-appreciation-sale-2026'), false, 'admin: non-canonical upper-case URL rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026' || chr(10)), false, 'admin: trailing newline rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'evil.example', 'https://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026'), false, 'admin: hostname that does not match the URL rejected');
select is(public.is_allowed_manual_source((select amazon from ids), 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/news/a/' || repeat('b', 2100)), false, 'admin: over-long URL rejected');
select is(public.is_allowed_manual_source(null, 'www.aboutamazon.jp', 'https://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026'), false, 'admin: null retailer rejected');
select is(public.is_allowed_manual_source((select amazon from ids), null, null), false, 'admin: null URL rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'news.example.com', 'https://news.example.com/sale-1'), false, 'admin: source with allow_manual_source = false rejected (even when enabled)');
select throws_ok($$select * from private.collection_sources$$, '42501', null, 'admin: source policies unreadable directly');
select throws_ok($$update private.collection_sources set enabled = true$$, '42501', null, 'admin: cannot enable a source');
reset role;
-- owner checks
select is((select row(enabled, allow_manual_source)::text from private.collection_sources where id = 'amazon-aboutamazon-news'), row(false, true)::text, 'aboutamazon source unchanged: collection disabled, manual allowed');
select is((select count(*) from public.sale_events), (select n from sale_events_before), 'policy checks never touched sale_events');
select is((select count(*)::int from public.collection_candidates), 0, 'policy checks created no candidate');

select * from finish();
