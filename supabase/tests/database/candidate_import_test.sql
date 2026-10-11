-- pgTAP tests for the atomic collection candidate import (Phase 5C-2).
-- Everything runs inside one transaction and is rolled back.

begin;

create extension if not exists pgtap with schema extensions;

select plan(64);

-- ============================================================
-- Structure and grants
-- ============================================================

select has_function('public', 'import_collection_candidate', array['uuid', 'uuid', 'text', 'text', 'timestamp with time zone', 'timestamp with time zone', 'boolean', 'text', 'timestamp with time zone'], 'import RPC exists');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.import_collection_candidate(uuid, uuid, text, text, timestamptz, timestamptz, boolean, text, timestamptz)'::regprocedure), 'import RPC is SECURITY DEFINER with empty search_path');
select ok(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = 'public.import_collection_candidate(uuid, uuid, text, text, timestamptz, timestamptz, boolean, text, timestamptz)'::regprocedure and a.grantee = 0), 'import RPC: no PUBLIC execute');
select ok(not has_function_privilege('anon', 'public.import_collection_candidate(uuid, uuid, text, text, timestamptz, timestamptz, boolean, text, timestamptz)', 'execute'), 'import RPC: anon cannot execute');
select ok(has_function_privilege('authenticated', 'public.import_collection_candidate(uuid, uuid, text, text, timestamptz, timestamptz, boolean, text, timestamptz)', 'execute'), 'import RPC: authenticated may execute (admin checked inside)');
select ok(not (select bool_or(has_table_privilege(r, 'public.collection_candidates', p)) from unnest(array['anon','authenticated']) r, unnest(array['INSERT','UPDATE','DELETE']) p), 'still no direct write grant on candidates');
select ok(not has_column_privilege('authenticated', 'public.sale_events', 'status', 'INSERT') and not has_column_privilege('authenticated', 'public.sale_events', 'status', 'UPDATE'), 'sale status still not writable by clients');
select is((select count(*)::int from private.collection_sources where enabled), 0, 'no source enabled for collection');

-- ============================================================
-- Fixtures (owner context)
-- ============================================================

insert into auth.users (id, email, aud, role)
values
  ('00000000-0000-4000-8000-0000000e0a01', 'import-admin@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000e0b01', 'import-user@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000e0c01', 'import-collector@example.invalid', 'authenticated', 'authenticated');
insert into public.admin_users (user_id) values ('00000000-0000-4000-8000-0000000e0a01');
insert into private.collector_users (user_id) values ('00000000-0000-4000-8000-0000000e0c01');
insert into public.retailers (slug, name, official_base_url, sort_order, is_active)
values ('test-inactive', '休止ショップ', 'https://www.inactive.example/', 99, false);
insert into private.collection_sources (id, retailer_id, expected_host, source_url_pattern)
values
  ('test-rakuten', (select id from public.retailers where slug = 'rakuten'), 'event.rakuten.co.jp', '^https://event\.rakuten\.co\.jp/[a-z0-9/_-]+$'),
  ('test-qoo10', (select id from public.retailers where slug = 'qoo10'), 'www.qoo10.jp', '^https://www\.qoo10\.jp/[a-z0-9/_-]+$'),
  ('test-inactive', (select id from public.retailers where slug = 'test-inactive'), 'www.inactive.example', '^https://www\.inactive\.example/[a-z0-9/_-]+$');

-- Candidates: a1 aboutamazon (source changed), a2 Amazon primary, a3/a4 for
-- failures, r1 Rakuten, q1 Qoo10 (imported), r2/q2 (failures), i1 inactive
-- retailer, d1 dismissed.
insert into public.collection_candidates (id, source_id, external_key, retailer_id, source_url, title, description, starts_at, ends_at, is_date_only, source_checked_at, evidence_excerpt, content_hash, last_seen_content_hash, parser_version, source_changed, review_state)
select v.id::uuid, v.src, v.id, (select id from public.retailers where slug = v.slug), v.url, v.title, '候補の説明',
       '2027-01-10 00:00+09', '2027-01-14 00:00+09', true, '2027-01-01 10:00+09', '候補の根拠',
       repeat('a', 64), repeat(v.h, 64), 'synthetic-1', v.changed, v.state
from (values
  ('00000000-0000-4000-8000-00000000c0a1', 'amazon-aboutamazon-news', 'amazon', 'https://www.aboutamazon.jp/news/amazon-prime/import-a1', '候補A1', 'b', true, 'new'),
  ('00000000-0000-4000-8000-00000000c0a2', 'amazon-aboutamazon-news', 'amazon', 'https://www.aboutamazon.jp/news/amazon-prime/import-a2', '候補A2', 'a', false, 'new'),
  ('00000000-0000-4000-8000-00000000c0a3', 'amazon-aboutamazon-news', 'amazon', 'https://www.aboutamazon.jp/news/amazon-prime/import-a3', '候補A3', 'a', false, 'new'),
  ('00000000-0000-4000-8000-00000000c0a4', 'amazon-aboutamazon-news', 'amazon', 'https://www.aboutamazon.jp/news/amazon-prime/import-a4', '候補A4', 'a', false, 'new'),
  ('00000000-0000-4000-8000-00000000c0b1', 'test-rakuten', 'rakuten', 'https://event.rakuten.co.jp/campaign/import-r1', '候補R1', 'a', false, 'new'),
  ('00000000-0000-4000-8000-00000000c0b2', 'test-qoo10', 'qoo10', 'https://www.qoo10.jp/import-q1', '候補Q1', 'a', false, 'new'),
  ('00000000-0000-4000-8000-00000000c0b5', 'test-rakuten', 'rakuten', 'https://event.rakuten.co.jp/campaign/import-r2', '候補R2', 'a', false, 'new'),
  ('00000000-0000-4000-8000-00000000c0b6', 'test-qoo10', 'qoo10', 'https://www.qoo10.jp/import-q2', '候補Q2', 'a', false, 'new'),
  ('00000000-0000-4000-8000-00000000c0b3', 'test-inactive', 'test-inactive', 'https://www.inactive.example/import-i1', '候補I1', 'a', false, 'new'),
  ('00000000-0000-4000-8000-00000000c0b4', 'amazon-aboutamazon-news', 'amazon', 'https://www.aboutamazon.jp/news/amazon-prime/import-d1', '候補D1', 'a', false, 'dismissed')
) as v(id, src, slug, url, title, h, changed, state);

-- An existing active sale for the duplicate scenario (Amazon, same title and JST start date).
insert into public.sale_events (retailer_id, title, starts_at, ends_at, is_date_only, source_url)
values ((select id from public.retailers where slug = 'amazon'), '既存の重複セール', '2027-02-01 00:00+09', '2027-02-03 00:00+09', true, 'https://www.amazon.co.jp/existing');

create temporary table counts_before as
select (select count(*) from public.sale_events) as sales, (select count(*) from public.sale_event_audit) as audits;
create temporary table imported (name text primary key, sale_id uuid);
grant select, insert on imported to authenticated;

-- imp(candidate, retailer slug, title, source url): the admin's final values.
create function pg_temp.imp(p_candidate uuid, p_slug text, p_title text, p_url text,
                            p_start timestamptz default '2027-01-10 00:00+09', p_end timestamptz default '2027-01-14 00:00+09')
returns uuid language sql as $$
  select public.import_collection_candidate(p_candidate, (select id from public.retailers where slug = p_slug), p_title, '管理者が確認した説明',
    p_start, p_end, true, p_url, '2027-01-02 09:00+09'::timestamptz);
$$;

-- ============================================================
-- Callers that are not admins
-- ============================================================

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok($$select public.import_collection_candidate('00000000-0000-4000-8000-00000000c0a2', null, 'x', null, now(), now() + interval '1 day', true, 'https://www.amazon.co.jp/x', now())$$, '42501', null, 'anon: import denied');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000e0b01","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a2', 'amazon', '非管理者', 'https://www.amazon.co.jp/x')$$, '42501', null, 'non-admin: import denied');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000e0c01","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a2', 'amazon', '収集者', 'https://www.amazon.co.jp/x')$$, '42501', null, 'collector: import denied');
reset role;
select is((select row(review_state, imported_sale_event_id is null)::text from public.collection_candidates where id = '00000000-0000-4000-8000-00000000c0a2'), row('new', true)::text, 'denied callers changed nothing');

-- ============================================================
-- Admin
-- ============================================================

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000e0a01","role":"authenticated"}', true);
set local role authenticated;

-- Successful imports
select lives_ok($$insert into imported select 'a1', pg_temp.imp('00000000-0000-4000-8000-00000000c0a1', 'amazon', '管理者が直したタイトル', 'https://www.aboutamazon.jp/news/amazon-prime/import-a1')$$, 'admin: aboutamazon candidate imported');
select lives_ok($$insert into imported select 'a2', pg_temp.imp('00000000-0000-4000-8000-00000000c0a2', 'amazon', '本体ドメインのセール', 'https://www.amazon.co.jp/fmc/import-a2')$$, 'admin: Amazon primary domain import');
select lives_ok($$insert into imported select 'r1', pg_temp.imp('00000000-0000-4000-8000-00000000c0b1', 'rakuten', '楽天のセール', 'https://event.rakuten.co.jp/campaign/import-r1')$$, 'admin: Rakuten primary domain import');
select lives_ok($$insert into imported select 'q1', pg_temp.imp('00000000-0000-4000-8000-00000000c0b2', 'qoo10', 'Qoo10のセール', 'https://www.qoo10.jp/import-q1')$$, 'admin: Qoo10 primary domain import');

-- Not importable
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a1', 'amazon', '二重取り込み', 'https://www.aboutamazon.jp/news/amazon-prime/import-a1')$$, '55000', null, 'admin: already imported candidate rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0b4', 'amazon', '見送り', 'https://www.aboutamazon.jp/news/amazon-prime/import-d1')$$, '55000', null, 'admin: dismissed candidate rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-0000000fffff', 'amazon', '存在しない', 'https://www.amazon.co.jp/x')$$, 'P0002', null, 'admin: missing candidate rejected');
select throws_ok($$select pg_temp.imp(null, 'amazon', 'null候補', 'https://www.amazon.co.jp/x')$$, 'P0002', null, 'admin: null candidate rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0b3', 'test-inactive', '休止', 'https://www.inactive.example/import-i1')$$, '22023', null, 'admin: inactive retailer rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a3', 'rakuten', '店舗違い', 'https://www.rakuten.co.jp/x')$$, '22023', null, 'admin: retailer different from the candidate rejected');

-- Source policy
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a3', 'amazon', '偽ドメイン', 'https://evil-aboutamazon.jp/news/amazon-prime/x')$$, '22023', null, 'admin: lookalike domain rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a3', 'amazon', '偽サフィックス', 'https://www.aboutamazon.jp.evil.example/news/amazon-prime/x')$$, '22023', null, 'admin: evil suffix rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a3', 'amazon', '偽本体', 'https://amazon.co.jp.evil.example/x')$$, '22023', null, 'admin: primary-domain suffix trick rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a3', 'amazon', 'http', 'http://www.aboutamazon.jp/news/amazon-prime/x')$$, '22023', null, 'admin: http rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a3', 'amazon', '認証情報', 'https://user@www.aboutamazon.jp/news/amazon-prime/x')$$, '22023', null, 'admin: credentials rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a3', 'amazon', 'ポート', 'https://www.aboutamazon.jp:8443/news/amazon-prime/x')$$, '22023', null, 'admin: port rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a3', 'amazon', '本体ポート', 'https://www.amazon.co.jp:443/x')$$, '22023', null, 'admin: port on the primary domain rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a3', 'amazon', '空白', 'https://www.amazon.co.jp/a b')$$, '22023', null, 'admin: whitespace in URL rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a3', 'amazon', 'RSS', 'https://www.aboutamazon.jp/rss/feed.rss')$$, '22023', null, 'admin: aboutamazon URL outside the approved pattern rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0b5', 'rakuten', '楽天でaboutamazon', 'https://www.aboutamazon.jp/news/amazon-prime/x')$$, '22023', null, 'admin: Rakuten with aboutamazon rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0b6', 'qoo10', 'Qoo10でaboutamazon', 'https://www.aboutamazon.jp/news/amazon-prime/x')$$, '22023', null, 'admin: Qoo10 with aboutamazon rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a3', 'amazon', '長すぎ', 'https://www.amazon.co.jp/' || repeat('x', 2100))$$, '22023', null, 'admin: over-long URL rejected');

-- Final values
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a3', 'amazon', '   ', 'https://www.amazon.co.jp/x')$$, '22023', null, 'admin: blank title rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a3', 'amazon', repeat('長', 201), 'https://www.amazon.co.jp/x')$$, '22023', null, 'admin: over-long title rejected');
select throws_ok($$select public.import_collection_candidate('00000000-0000-4000-8000-00000000c0a3', (select id from public.retailers where slug = 'amazon'), '説明長すぎ', repeat('x', 5001), '2027-01-10 00:00+09', '2027-01-14 00:00+09', true, 'https://www.amazon.co.jp/x', '2027-01-02 09:00+09')$$, '22023', null, 'admin: over-long description rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a3', 'amazon', '逆順', 'https://www.amazon.co.jp/x', '2027-01-14 00:00+09', '2027-01-10 00:00+09')$$, '22023', null, 'admin: end before start rejected');
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a3', 'amazon', '古すぎ', 'https://www.amazon.co.jp/x', '2019-12-31 00:00+09', '2020-01-02 00:00+09')$$, '22023', null, 'admin: start before 2020 rejected');
select throws_ok($$select public.import_collection_candidate('00000000-0000-4000-8000-00000000c0a3', (select id from public.retailers where slug = 'amazon'), 'null', null, '2027-01-10 00:00+09', '2027-01-14 00:00+09', true, 'https://www.amazon.co.jp/x', null)$$, '22023', null, 'admin: missing checked time rejected');

-- Duplicate sale: the whole import rolls back.
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a4', 'amazon', '既存の重複セール', 'https://www.amazon.co.jp/dup', '2027-02-01 00:00+09', '2027-02-02 00:00+09')$$, '23505', null, 'admin: duplicate sale rejected');

-- Direct writes stay impossible, even for admins.
select throws_ok($$update public.collection_candidates set review_state = 'imported'$$, '42501', null, 'admin: direct candidate update denied');
select throws_ok($$delete from public.collection_candidates$$, '42501', null, 'admin: direct candidate delete denied');
reset role;

-- ============================================================
-- Results (owner context)
-- ============================================================

select is((select count(*)::int from imported), 4, 'four imports succeeded');
select is((select string_agg(e.status, ',' order by i.name) from imported i join public.sale_events e on e.id = i.sale_id), 'pending_review,pending_review,pending_review,pending_review', 'imported sales are pending_review');
select is((select count(*)::int from imported i join public.sale_events e on e.id = i.sale_id where e.published_at is not null or e.rejected_at is not null or e.archived_at is not null), 0, 'no lifecycle timestamps set (no auto publish)');
select is((select count(*)::int from imported i join public.collection_candidates c on c.imported_sale_event_id = i.sale_id where c.review_state = 'imported'), 4, 'each candidate is imported and linked to its sale');
select is((select imported_sale_event_id from public.collection_candidates where id = '00000000-0000-4000-8000-00000000c0a1'), (select sale_id from imported where name = 'a1'), 'a1 linked to the exact sale');
select is((select row(e.title, e.description, e.source_url, e.is_date_only, e.starts_at = '2027-01-10 00:00+09', e.source_checked_at = '2027-01-02 09:00+09')::text from imported i join public.sale_events e on e.id = i.sale_id where i.name = 'a1'),
          row('管理者が直したタイトル', '管理者が確認した説明', 'https://www.aboutamazon.jp/news/amazon-prime/import-a1', true, true, true)::text, 'sale uses the admin''s final values');
select is((select row(e.title_key, e.start_date_jst)::text from imported i join public.sale_events e on e.id = i.sale_id where i.name = 'a1'), row('管理者が直したタイトル', '2027-01-10'::date)::text, 'derived columns set by trigger');
select is((select string_agg(a.action || ':' || (a.actor_user_id = '00000000-0000-4000-8000-0000000e0a01'), ',') from imported i join public.sale_event_audit a on a.sale_event_id = i.sale_id where i.name = 'a1'), 'create:true', 'exactly one create audit row by the admin');
select is((select row(title, description, source_url, evidence_excerpt, content_hash, last_seen_content_hash, source_changed, starts_at = '2027-01-10 00:00+09')::text from public.collection_candidates where id = '00000000-0000-4000-8000-00000000c0a1'),
          row('候補A1', '候補の説明', 'https://www.aboutamazon.jp/news/amazon-prime/import-a1', '候補の根拠', repeat('a', 64), repeat('b', 64), true, true)::text, 'candidate content and source_changed unchanged');
select is((select (select count(*) from public.sale_events) - sales from counts_before)::int, 4, 'only the four successful imports created sales');
select is((select (select count(*) from public.sale_event_audit) - audits from counts_before)::int, 4, 'only the four successful imports wrote audit rows');
select is((select string_agg(review_state || ':' || (imported_sale_event_id is null), ',' order by id) from public.collection_candidates where id in ('00000000-0000-4000-8000-00000000c0a3', '00000000-0000-4000-8000-00000000c0a4', '00000000-0000-4000-8000-00000000c0b3', '00000000-0000-4000-8000-00000000c0b4', '00000000-0000-4000-8000-00000000c0b5', '00000000-0000-4000-8000-00000000c0b6')),
          'new:true,new:true,new:true,dismissed:true,new:true,new:true', 'failed imports left their candidates unchanged (duplicate, source, retailer, dismissed)');
select is((select count(*)::int from public.sale_events where title in ('偽ドメイン', 'http', 'ポート', '店舗違い', '休止', '見送り', '二重取り込み')), 0, 'failed imports created no sale');
select is((select count(*)::int from public.sale_events where title_key = '既存の重複セール'), 1, 'duplicate import left only the original sale');
select is((select row(enabled, allow_manual_source)::text from private.collection_sources where id = 'amazon-aboutamazon-news'), row(false, true)::text, 'aboutamazon stays manual-only (collection disabled)');

-- Candidate update failure: the sale insert is rolled back too.
create function public.test_fail_candidate_update() returns trigger language plpgsql as $$
begin
  raise exception 'simulated candidate update failure' using errcode = 'XX000';
end;
$$;
create trigger test_fail_candidate_update before update on public.collection_candidates
  for each row execute function public.test_fail_candidate_update();
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000e0a01","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a3', 'amazon', '更新失敗', 'https://www.amazon.co.jp/fail')$$, 'XX000', null, 'admin: candidate update failure aborts the import');
reset role;
select is((select count(*)::int from public.sale_events where title = '更新失敗'), 0, 'no sale left behind after a candidate update failure');
select is((select review_state from public.collection_candidates where id = '00000000-0000-4000-8000-00000000c0a3'), 'new', 'candidate still new after the failure');
drop trigger test_fail_candidate_update on public.collection_candidates;

-- Audit failure: nothing is left behind either.
create function public.test_fail_audit() returns trigger language plpgsql as $$
begin
  raise exception 'simulated audit failure' using errcode = 'XX000';
end;
$$;
create trigger test_fail_audit before insert on public.sale_event_audit
  for each row execute function public.test_fail_audit();
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000e0a01","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select pg_temp.imp('00000000-0000-4000-8000-00000000c0a3', 'amazon', '監査失敗', 'https://www.amazon.co.jp/fail')$$, 'XX000', null, 'admin: audit failure aborts the import');
reset role;
select is((select row(review_state, (select count(*) from public.sale_events where title = '監査失敗'))::text from public.collection_candidates where id = '00000000-0000-4000-8000-00000000c0a3'), row('new', 0)::text, 'no sale and candidate still new after an audit failure');
drop trigger test_fail_audit on public.sale_event_audit;

-- Anonymous visitors still cannot see the imported (pending_review) sales.
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select is((select count(*)::int from public.sale_events where title in ('管理者が直したタイトル', '本体ドメインのセール', '楽天のセール', 'Qoo10のセール')), 0, 'anon: imported sales are not public');
reset role;

select * from finish();
