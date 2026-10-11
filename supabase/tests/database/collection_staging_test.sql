-- pgTAP tests for the collection staging foundation (Phase 5B).
-- Everything runs inside one transaction and is rolled back.

begin;

create extension if not exists pgtap with schema extensions;

select plan(59);

-- ============================================================
-- Structure and grants (state right after the migration)
-- ============================================================

select has_table('public', 'collection_candidates', 'collection_candidates exists');
select has_table('private', 'collection_sources', 'private.collection_sources exists');
select has_table('private', 'collector_users', 'private.collector_users exists');
select ok((select relrowsecurity from pg_class where oid = 'public.collection_candidates'::regclass), 'RLS enabled on public.collection_candidates');
select ok((select relrowsecurity from pg_class where oid = 'private.collection_sources'::regclass), 'RLS enabled on private.collection_sources');
select ok((select relrowsecurity from pg_class where oid = 'private.collector_users'::regclass), 'RLS enabled on private.collector_users');
select is((select string_agg(cmd || ':' || array_to_string(roles, ','), ',') from pg_policies where schemaname = 'public' and tablename = 'collection_candidates'), 'SELECT:authenticated', 'candidates have one read policy only');
select ok(not (select bool_or(has_table_privilege(r, t, p)) from unnest(array['anon','authenticated']) r, unnest(array['private.collection_sources','private.collector_users']) t, unnest(array['SELECT','INSERT','UPDATE','DELETE']) p), 'no client privilege on private collector tables');
select ok(has_table_privilege('authenticated', 'public.collection_candidates', 'SELECT') and not has_table_privilege('authenticated', 'public.collection_candidates', 'INSERT') and not has_table_privilege('authenticated', 'public.collection_candidates', 'UPDATE') and not has_table_privilege('authenticated', 'public.collection_candidates', 'DELETE'), 'authenticated may only SELECT candidates (RLS limits to admins)');
select ok(not (select bool_or(has_table_privilege('anon', 'public.collection_candidates', p)) from unnest(array['SELECT','INSERT','UPDATE','DELETE']) p), 'anon has no privilege on candidates');
select ok(not has_function_privilege('anon', 'private.is_collector()', 'execute') and not has_function_privilege('authenticated', 'private.is_collector()', 'execute'), 'is_collector() is not executable by clients');
select ok(not has_function_privilege('anon', 'public.submit_collection_candidate(text, text, uuid, text, text, text, timestamptz, timestamptz, boolean, timestamptz, text, text, text)', 'execute') and has_function_privilege('authenticated', 'public.submit_collection_candidate(text, text, uuid, text, text, text, timestamptz, timestamptz, boolean, timestamptz, text, text, text)', 'execute'), 'submit RPC: authenticated only');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.submit_collection_candidate(text, text, uuid, text, text, text, timestamptz, timestamptz, boolean, timestamptz, text, text, text)'::regprocedure), 'submit RPC is SECURITY DEFINER with empty search_path');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'private.is_collector()'::regprocedure), 'is_collector() is SECURITY DEFINER with empty search_path');
select is((select count(*)::int from private.collection_sources where enabled) + (select count(*)::int from private.collector_users) + (select count(*)::int from public.collection_candidates), 0, 'migrations seed no enabled source, collector or candidate');

-- ============================================================
-- Fixtures (owner context)
-- ============================================================

insert into auth.users (id, email, aud, role)
values
  ('00000000-0000-4000-8000-0000000c0a01', 'staging-admin@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000c0b01', 'staging-user@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000c0c01', 'staging-collector@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000c0c02', 'staging-collector-off@example.invalid', 'authenticated', 'authenticated');
insert into public.admin_users (user_id) values ('00000000-0000-4000-8000-0000000c0a01');
insert into private.collector_users (user_id, is_active) values ('00000000-0000-4000-8000-0000000c0c01', true), ('00000000-0000-4000-8000-0000000c0c02', false);
insert into private.collection_sources (id, retailer_id, expected_host, source_url_pattern, enabled)
values
  ('test-amazon', (select id from public.retailers where slug = 'amazon'), 'www.aboutamazon.jp',
   '^https://www\.aboutamazon\.jp/news/[a-z0-9/_-]+$', true),
  ('test-disabled', (select id from public.retailers where slug = 'amazon'), 'www.aboutamazon.jp',
   '^https://www\.aboutamazon\.jp/news/[a-z0-9/_-]+$', false);
create temporary table sale_events_before as select count(*) as n from public.sale_events;

-- anon
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok($$select * from public.collection_candidates$$, '42501', null, 'anon: candidates select denied');
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'https://www.aboutamazon.jp/news/sale-1', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '42501', null, 'anon: submit denied');
reset role;
-- inactive collector
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0c02","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'https://www.aboutamazon.jp/news/sale-1', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '42501', null, 'inactive collector: submit denied');
reset role;
-- active collector
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0c01","role":"authenticated"}', true);
set local role authenticated;
select is((select public.submit_collection_candidate('test-amazon', 'https://www.aboutamazon.jp/news/sale-1', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')), 'inserted', 'collector: valid candidate inserted');
select is((select public.submit_collection_candidate('test-amazon', 'https://www.aboutamazon.jp/news/sale-1', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')), 'seen', 'collector: same content is seen, not duplicated');
select is((select public.submit_collection_candidate('test-amazon', 'https://www.aboutamazon.jp/news/sale-1', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭（日程変更）', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'synthetic-1')), 'changed', 'collector: changed content is flagged');
select is((select public.submit_collection_candidate('test-amazon', 'https://www.aboutamazon.jp/news/sale-1', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')), 'seen', 'collector: original content again is seen');
select throws_ok($$select public.submit_collection_candidate('test-disabled', 'https://www.aboutamazon.jp/news/sale-1', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '55000', null, 'collector: disabled source rejected');
select throws_ok($$select public.submit_collection_candidate('no-such-source', 'https://www.aboutamazon.jp/news/sale-1', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '22023', null, 'collector: unknown source rejected');
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'https://www.aboutamazon.jp/news/sale-1', (select id from public.retailers where slug = 'rakuten'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '22023', null, 'collector: wrong retailer rejected');
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'https://www.aboutamazon.jp/news/sale-1', (select id from public.retailers where slug = 'amazon'), 'https://evil.example/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '22023', null, 'collector: wrong host rejected');
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'https://www.aboutamazon.jp/news/sale-1', (select id from public.retailers where slug = 'amazon'), 'http://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '22023', null, 'collector: http URL rejected');
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'https://www.aboutamazon.jp/news/sale-1', (select id from public.retailers where slug = 'amazon'), 'https://user@www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '22023', null, 'collector: URL with credentials rejected');
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'https://www.aboutamazon.jp/news/sale-1', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp:8443/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '22023', null, 'collector: URL with port rejected');
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'https://www.aboutamazon.jp/news/sale-1', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/other/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '22023', null, 'collector: URL outside source pattern rejected');
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'has space', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '22023', null, 'collector: invalid external key rejected');
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'https://www.aboutamazon.jp/news/sale-1', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'ABC', 'synthetic-1')$$, '22023', null, 'collector: invalid content hash rejected');
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'https://www.aboutamazon.jp/news/sale-1', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bad version!')$$, '22023', null, 'collector: invalid parser version rejected');
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'k-range', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-10 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '22023', null, 'collector: end not after start rejected');
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'k-future', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now() + interval '1 day', 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '22023', null, 'collector: future checked time rejected');
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'k-title', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', '   ', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '23514', null, 'collector: blank title rejected by constraint');
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'k-evidence', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), repeat('x', 2001), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '23514', null, 'collector: oversized evidence rejected');
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'k-null', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, null, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '22023', null, 'collector: missing field rejected');
select throws_ok($$insert into public.collection_candidates (source_id) values ('test-amazon')$$, '42501', null, 'collector: direct candidate insert denied');
select throws_ok($$update public.collection_candidates set title = 'x'$$, '42501', null, 'collector: direct candidate update denied');
select is((select count(*)::int from public.collection_candidates), 0, 'collector: cannot read candidates directly');
select throws_ok($$select * from private.collection_sources$$, '42501', null, 'collector: private sources unreadable');
select throws_ok($$select * from private.collector_users$$, '42501', null, 'collector: private collectors unreadable');
select throws_ok($$insert into public.sale_events (retailer_id, title, starts_at, ends_at, source_url) values ((select id from public.retailers where slug = 'amazon'), 'collector write', '2027-01-10 00:00+09', '2027-01-11 00:00+09', 'https://www.amazon.co.jp/')$$, '42501', null, 'collector: sale_events insert denied');
select throws_ok($$select public.publish_sale_event('00000000-0000-4000-8000-000000000000')$$, '42501', null, 'collector: lifecycle RPC denied (not admin)');
reset role;
-- non-admin user
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0b01","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.collection_candidates), 0, 'non-admin: sees no candidates');
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'k-user', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '42501', null, 'non-admin: submit denied');
select throws_ok($$delete from public.collection_candidates$$, '42501', null, 'non-admin: delete denied');
reset role;
-- admin
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0a01","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.collection_candidates), 1, 'admin: reads candidates');
select throws_ok($$insert into public.collection_candidates (source_id) values ('test-amazon')$$, '42501', null, 'admin: direct insert denied');
select throws_ok($$update public.collection_candidates set review_state = 'dismissed'$$, '42501', null, 'admin: direct update denied');
select throws_ok($$delete from public.collection_candidates$$, '42501', null, 'admin: direct delete denied');
select throws_ok($$select public.submit_collection_candidate('test-amazon', 'k-admin', (select id from public.retailers where slug = 'amazon'), 'https://www.aboutamazon.jp/news/sale-1', 'プライム感謝祭', null, '2027-01-10 00:00+09'::timestamptz, '2027-01-14 00:00+09'::timestamptz, false, now(), 'Amazon、プライム感謝祭を開催', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'synthetic-1')$$, '42501', null, 'admin: submit denied (not a collector)');
select throws_ok($$select * from private.collection_sources$$, '42501', null, 'admin: private sources unreadable');
reset role;
-- owner checks
select is((select count(*)::int from public.collection_candidates where source_id = 'test-amazon'), 1, 'one row per source and external key');
select is((select row(title, content_hash, last_seen_content_hash, source_changed, review_state, imported_sale_event_id is null)::text from public.collection_candidates where external_key = 'https://www.aboutamazon.jp/news/sale-1'), row('プライム感謝祭', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, 'new', true)::text, 'original content kept, latest hash tracked, change flag sticky, still new');
select ok((select last_seen_at >= first_seen_at from public.collection_candidates limit 1), 'last_seen_at tracks repeated sightings');
select is((select count(*) from public.sale_events), (select n from sale_events_before), 'collector activity never touched sale_events');
select throws_ok($$update public.collection_candidates set review_state = 'imported'$$, '23514', null, 'imported state requires a linked sale event');

select * from finish();

rollback;
