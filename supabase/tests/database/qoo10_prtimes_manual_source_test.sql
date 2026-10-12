-- pgTAP tests for eBay Japan PR TIMES articles as a Qoo10 manual source (Phase 6B).
-- Everything runs inside one transaction and is rolled back.
-- Article URLs are synthetic (release numbers chosen for the test).

begin;

create extension if not exists pgtap with schema extensions;

select plan(42);

-- ============================================================
-- State right after the migration
-- ============================================================

select is((select count(*)::int from private.collection_sources where id = 'qoo10-ebay-japan-press'), 1, 'eBay Japan PR TIMES source policy exists once');
select is((select row(retailer_id = (select id from public.retailers where slug = 'qoo10'), expected_host, enabled, allow_manual_source)::text from private.collection_sources where id = 'qoo10-ebay-japan-press'), row(true, 'prtimes.jp', false, true)::text, 'eBay Japan PR TIMES: Qoo10 retailer, exact host, manual only, collection disabled');
select is((select count(*)::int from private.collection_sources where expected_host = 'prtimes.jp'), 1, 'PR TIMES appears in exactly one source policy');
select is((select row(enabled, allow_manual_source)::text from private.collection_sources where id = 'amazon-aboutamazon-news'), row(false, true)::text, 'aboutamazon policy unchanged');
select is((select count(*)::int from private.collection_sources where enabled), 0, 'no source is enabled for collection');
select is((select count(*)::int from private.collector_users) + (select count(*)::int from public.collection_candidates), 0, 'no collector or candidate is created');
select ok(not (select bool_or(has_table_privilege(r, 'private.collection_sources', p)) from unnest(array['anon','authenticated']) r, unnest(array['SELECT','INSERT','UPDATE','DELETE']) p), 'collection_sources stays private');

-- ============================================================
-- Fixtures (owner context)
-- ============================================================

insert into auth.users (id, email, aud, role)
values
  ('00000000-0000-4000-8000-0000000f0a01', 'prtimes-admin@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000f0b01', 'prtimes-user@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000f0c01', 'prtimes-collector@example.invalid', 'authenticated', 'authenticated');
insert into public.admin_users (user_id) values ('00000000-0000-4000-8000-0000000f0a01');
insert into private.collector_users (user_id, is_active) values ('00000000-0000-4000-8000-0000000f0c01', true);
create temporary table sale_events_before as select count(*) as n from public.sale_events;
create temporary table ids as
select (select id from public.retailers where slug = 'amazon') as amazon,
       (select id from public.retailers where slug = 'rakuten') as rakuten,
       (select id from public.retailers where slug = 'qoo10') as qoo10;
grant select on ids to anon, authenticated;

-- anon
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok($$select public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp/main/html/rd/p/000009999.000022933.html')$$, '42501', null, 'anon: manual source RPC denied');
reset role;
-- ordinary authenticated user
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000f0b01","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp/main/html/rd/p/000009999.000022933.html')$$, '42501', null, 'non-admin: manual source RPC denied');
reset role;
-- collector: the PR TIMES source is disabled for collection
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000f0c01","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.submit_collection_candidate('qoo10-ebay-japan-press', 'https://prtimes.jp/main/html/rd/p/000009999.000022933.html', (select qoo10 from ids), 'https://prtimes.jp/main/html/rd/p/000009999.000022933.html', 'Qoo10メガ割', null, '2027-03-01 17:00+09'::timestamptz, '2027-03-13 01:00+09'::timestamptz, false, now(), 'Qoo10、メガ割を開催', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'synthetic-prtimes-1')$$, '55000', null, 'collector: manual-only PR TIMES source rejected (disabled)');
select throws_ok($$select public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp/main/html/rd/p/000009999.000022933.html')$$, '42501', null, 'collector: manual source RPC denied (not admin)');
reset role;
-- admin
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000f0a01","role":"authenticated"}', true);
set local role authenticated;
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp/main/html/rd/p/000009999.000022933.html'), true, 'admin: eBay Japan article allowed for Qoo10');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp/main/html/rd/p/000000123.000022933.html'), true, 'admin: another eBay Japan release number allowed');
select is(public.is_allowed_manual_source((select amazon from ids), 'prtimes.jp', 'https://prtimes.jp/main/html/rd/p/000009999.000022933.html'), false, 'admin: Amazon with eBay Japan article rejected');
select is(public.is_allowed_manual_source((select rakuten from ids), 'prtimes.jp', 'https://prtimes.jp/main/html/rd/p/000009999.000022933.html'), false, 'admin: Rakuten with eBay Japan article rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp/main/html/rd/p/000009999.000012345.html'), false, 'admin: other publisher rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp/main/html/rd/p/000009999.000022934.html'), false, 'admin: neighbouring publisher id rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp/main/html/rd/p/000009999.0000229330.html'), false, 'admin: publisher id with extra digit rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp/main/html/rd/p/9999.000022933.html'), false, 'admin: short release number rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp/main/html/rd/p/0000099990.000022933.html'), false, 'admin: long release number rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'www.prtimes.jp', 'https://www.prtimes.jp/main/html/rd/p/000009999.000022933.html'), false, 'admin: www subdomain rejected (exact host)');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp.evil.example', 'https://prtimes.jp.evil.example/main/html/rd/p/000009999.000022933.html'), false, 'admin: evil suffix rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'evil-prtimes.jp', 'https://evil-prtimes.jp/main/html/rd/p/000009999.000022933.html'), false, 'admin: lookalike domain rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.co.jp', 'https://prtimes.co.jp/main/html/rd/p/000009999.000022933.html'), false, 'admin: wrong host rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'http://prtimes.jp/main/html/rd/p/000009999.000022933.html'), false, 'admin: http rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://user@prtimes.jp/main/html/rd/p/000009999.000022933.html'), false, 'admin: credentials rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp:443/main/html/rd/p/000009999.000022933.html'), false, 'admin: explicit port rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp/main/html/rd/p/000009999.000022933.html?utm_source=rss'), false, 'admin: query string rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp/main/html/rd/p/000009999.000022933.html#top'), false, 'admin: fragment rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp/companyrdf.php?company_id=22933'), false, 'admin: company feed rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp/main/html/searchrlp/company_id/22933'), false, 'admin: company page rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp/index.rdf'), false, 'admin: site feed rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp/main/html/rd/p/000009999.000022933.html/extra'), false, 'admin: deeper path rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://PRTIMES.JP/main/html/rd/p/000009999.000022933.html'), false, 'admin: non-canonical upper-case URL rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'prtimes.jp', 'https://prtimes.jp/main/html/rd/p/000009999.000022933.html' || chr(10)), false, 'admin: trailing newline rejected');
select is(public.is_allowed_manual_source((select qoo10 from ids), 'evil.example', 'https://prtimes.jp/main/html/rd/p/000009999.000022933.html'), false, 'admin: hostname that does not match the URL rejected');
-- A sale registered with the article is created for review, never published.
select lives_ok($$insert into public.sale_events (retailer_id, title, starts_at, ends_at, source_url) values ((select qoo10 from ids), 'Qoo10メガ割（PR TIMES出典テスト）', '2027-03-01 17:00+09', '2027-03-13 01:00+09', 'https://prtimes.jp/main/html/rd/p/000009999.000022933.html')$$, 'admin: sale citing the article can be registered');
select throws_ok($$update private.collection_sources set enabled = true where id = 'qoo10-ebay-japan-press'$$, '42501', null, 'admin: cannot enable the PR TIMES source');
reset role;
-- owner checks
select is((select status::text from public.sale_events where title = 'Qoo10メガ割（PR TIMES出典テスト）'), 'pending_review', 'registered sale waits for review (no auto publish)');
select is((select count(*) from public.sale_events), (select n from sale_events_before) + 1, 'only the one registered sale was added');
select is((select row(enabled, allow_manual_source)::text from private.collection_sources where id = 'qoo10-ebay-japan-press'), row(false, true)::text, 'PR TIMES source unchanged: collection disabled, manual allowed');
select is((select count(*)::int from public.collection_candidates), 0, 'no candidate was created');

select * from finish();
