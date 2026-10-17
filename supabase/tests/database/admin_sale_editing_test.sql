-- pgTAP tests for admin-only sale editing (Phase 6F).
-- Everything runs inside one transaction and is rolled back. now() is fixed
-- inside a transaction, so a successful save keeps updated_at here; staleness
-- is tested with a deliberately different expected value.

begin;

create extension if not exists pgtap with schema extensions;

select plan(54);

-- ============================================================
-- Structure and grants
-- ============================================================

select has_function('public', 'update_sale_event',
  array['uuid', 'timestamp with time zone', 'boolean', 'text', 'text', 'timestamp with time zone',
        'timestamp with time zone', 'boolean', 'text', 'timestamp with time zone'],
  'update RPC exists');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.update_sale_event(uuid, timestamptz, boolean, text, text, timestamptz, timestamptz, boolean, text, timestamptz)'::regprocedure), 'update RPC is SECURITY DEFINER with empty search_path');
select ok(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = 'public.update_sale_event(uuid, timestamptz, boolean, text, text, timestamptz, timestamptz, boolean, text, timestamptz)'::regprocedure and a.grantee = 0), 'update RPC: no PUBLIC execute');
select ok(not has_function_privilege('anon', 'public.update_sale_event(uuid, timestamptz, boolean, text, text, timestamptz, timestamptz, boolean, text, timestamptz)', 'execute'), 'update RPC: anon cannot execute');
select ok(has_function_privilege('authenticated', 'public.update_sale_event(uuid, timestamptz, boolean, text, text, timestamptz, timestamptz, boolean, text, timestamptz)', 'execute'), 'update RPC: authenticated may execute (admin checked inside)');
select ok(not has_function_privilege('anon', 'private.assert_valid_sale_content(uuid, text, text, timestamptz, timestamptz, boolean, text, timestamptz)', 'execute') and not has_function_privilege('authenticated', 'private.assert_valid_sale_content(uuid, text, text, timestamptz, timestamptz, boolean, text, timestamptz)', 'execute'), 'content validator is not callable by clients');
select ok(not has_table_privilege('authenticated', 'public.sale_events', 'UPDATE') and not has_table_privilege('anon', 'public.sale_events', 'UPDATE'), 'no table-level UPDATE on sale_events for clients');
select ok(not (select bool_or(has_column_privilege(r, 'public.sale_events', c, 'UPDATE')) from unnest(array['anon','authenticated']) r, unnest(array['retailer_id','title','description','starts_at','ends_at','is_date_only','source_url','source_checked_at','status']) c), 'no column-level UPDATE on sale_events for clients');
select ok(exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sale_events' and policyname = 'sale_events_admin_update'), 'sale_events_admin_update RLS policy is kept');
select ok(has_column_privilege('authenticated', 'public.sale_events', 'title', 'INSERT'), 'manual create INSERT grant is unchanged');

-- ============================================================
-- Fixtures (owner context)
-- ============================================================

insert into auth.users (id, email, aud, role)
values
  ('00000000-0000-4000-8000-0000000f1a01', 'edit-admin@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000f1b01', 'edit-user@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000f1c01', 'edit-collector@example.invalid', 'authenticated', 'authenticated');
insert into public.admin_users (user_id) values ('00000000-0000-4000-8000-0000000f1a01');
insert into private.collector_users (user_id, is_active) values ('00000000-0000-4000-8000-0000000f1c01', true);

insert into public.sale_events (id, retailer_id, title, description, starts_at, ends_at, is_date_only, source_url, source_checked_at)
values
  ('20000000-0000-4000-8000-000000000001', (select id from public.retailers where slug = 'rakuten'), 'Edit Pending', 'before',
   '2027-07-01 00:00+09', '2027-07-03 00:00+09', true, 'https://www.rakuten.co.jp/event/a/', '2027-06-20 10:00+09'),
  ('20000000-0000-4000-8000-000000000002', (select id from public.retailers where slug = 'amazon'), 'Edit Published', null,
   '2027-07-10 20:00+09', '2027-07-12 10:00+09', false, 'https://www.amazon.co.jp/events/x', '2027-06-20 10:00+09'),
  ('20000000-0000-4000-8000-000000000003', (select id from public.retailers where slug = 'qoo10'), 'Edit Rejected', null,
   '2027-07-20 17:00+09', '2027-07-25 01:00+09', false, 'https://www.qoo10.jp/gmkt.inc/Special/x', '2027-06-20 10:00+09'),
  ('20000000-0000-4000-8000-000000000004', (select id from public.retailers where slug = 'rakuten'), 'Edit Archived', null,
   '2027-06-01 00:00+09', '2027-06-02 00:00+09', true, 'https://www.rakuten.co.jp/event/z/', '2027-05-20 10:00+09'),
  ('20000000-0000-4000-8000-000000000005', (select id from public.retailers where slug = 'rakuten'), 'Dup Target', null,
   '2027-08-01 00:00+09', '2027-08-02 00:00+09', true, 'https://www.rakuten.co.jp/event/d/', '2027-06-20 10:00+09');
update public.sale_events set status = 'published' where id in ('20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000004');
update public.sale_events set status = 'rejected' where id = '20000000-0000-4000-8000-000000000003';
update public.sale_events set status = 'archived' where id = '20000000-0000-4000-8000-000000000004';

create temporary table before_rows as
select id, retailer_id, status, created_at, published_at, rejected_at, archived_at, title, ends_at
from public.sale_events where id::text like '20000000-%';
create temporary table audit_before as select count(*) as n from public.sale_event_audit;
grant select on before_rows, audit_before to anon, authenticated;

-- ============================================================
-- Not an admin
-- ============================================================

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', now(), false, 'x', null, '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://www.rakuten.co.jp/event/a/', '2027-06-20 10:00+09')$$, '42501', null, 'anon: update RPC denied');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000f1b01","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', now(), false, 'x', null, '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://www.rakuten.co.jp/event/a/', '2027-06-20 10:00+09')$$, '42501', 'insufficient privilege', 'non-admin: update RPC fails the admin check');
select throws_ok($$update public.sale_events set title = 'forged' where id = '20000000-0000-4000-8000-000000000001'$$, '42501', null, 'non-admin: direct UPDATE denied');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000f1c01","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', now(), false, 'x', null, '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://www.rakuten.co.jp/event/a/', '2027-06-20 10:00+09')$$, '42501', 'insufficient privilege', 'collector: update RPC fails the admin check');
reset role;

select is((select count(*)::int from public.sale_events e join before_rows b using (id) where e.title is distinct from b.title or e.ends_at is distinct from b.ends_at), 0, 'denied callers changed nothing');

-- ============================================================
-- Admin
-- ============================================================

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000f1a01","role":"authenticated"}', true);
set local role authenticated;

select throws_ok($$update public.sale_events set title = 'direct' where id = '20000000-0000-4000-8000-000000000001'$$, '42501', null, 'admin: direct UPDATE denied (RPC only)');

-- pending_review
select lives_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), false, 'Edit Pending Fixed', 'after', '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://www.rakuten.co.jp/event/a/', '2027-06-20 10:00+09')$$, 'admin: pending_review sale updated');
select is((select row(title, description, ends_at = '2027-07-04 00:00+09'::timestamptz, status)::text from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), row('Edit Pending Fixed', 'after', true, 'pending_review')::text, 'pending edit: content changed, still pending_review');
select is((select a.action || '|' || a.actor_user_id::text || '|' || coalesce(a.note, '<null>') from public.sale_event_audit a where a.sale_event_id = '20000000-0000-4000-8000-000000000001' order by a.id desc limit 1), 'update|00000000-0000-4000-8000-0000000f1a01|<null>', 'pending edit: audit update by the admin, null note');
select is((select row(a.old_data->>'title', a.new_data->>'title', a.old_data->>'description', a.new_data->>'description', (a.new_data->>'ends_at')::timestamptz = '2027-07-04 00:00+09'::timestamptz)::text from public.sale_event_audit a where a.sale_event_id = '20000000-0000-4000-8000-000000000001' order by a.id desc limit 1), row('Edit Pending', 'Edit Pending Fixed', 'before', 'after', true)::text, 'pending edit: audit keeps before and after');

-- published needs confirmation
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000002', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000002'), false, 'Edit Published', null, '2027-07-10 20:00+09', '2027-07-12 11:00+09', false, 'https://www.amazon.co.jp/events/x', '2027-06-20 10:00+09')$$, '22023', null, 'published edit without confirmation rejected');
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000002', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000002'), null, 'Edit Published', null, '2027-07-10 20:00+09', '2027-07-12 11:00+09', false, 'https://www.amazon.co.jp/events/x', '2027-06-20 10:00+09')$$, '22023', null, 'published edit with null confirmation rejected');
select lives_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000002', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000002'), true, 'Edit Published', null, '2027-07-10 20:00+09', '2027-07-12 11:00+09', false, 'https://www.amazon.co.jp/events/x', '2027-06-20 10:00+09')$$, 'published edit with confirmation succeeds');
select ok((select e.status = 'published' and e.published_at = b.published_at and e.ends_at = '2027-07-12 11:00+09'::timestamptz from public.sale_events e join before_rows b using (id) where e.id = '20000000-0000-4000-8000-000000000002'), 'published edit: still published, published_at kept, end changed');

-- rejected (Qoo10 with the approved PR TIMES manual source and a newer check)
select lives_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000003', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000003'), false, 'Edit Rejected', null, '2027-07-20 17:00+09', '2027-07-25 02:00+09', false, 'https://prtimes.jp/main/html/rd/p/000009999.000022933.html', '2027-06-22 09:00+09')$$, 'rejected edit with approved manual source succeeds');
select ok((select e.status = 'rejected' and e.rejected_at = b.rejected_at from public.sale_events e join before_rows b using (id) where e.id = '20000000-0000-4000-8000-000000000003'), 'rejected edit: still rejected (no reopen), rejected_at kept');

-- retailer, status and system columns never change
select is((select count(*)::int from public.sale_events e join before_rows b using (id) where e.retailer_id <> b.retailer_id or e.status <> b.status or e.created_at <> b.created_at or e.published_at is distinct from b.published_at or e.rejected_at is distinct from b.rejected_at or e.archived_at is distinct from b.archived_at), 0, 'retailer, status and lifecycle columns unchanged by edits');

-- archived, missing, stale
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000004', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000004'), true, 'Edit Archived', null, '2027-06-01 00:00+09', '2027-06-03 00:00+09', true, 'https://www.rakuten.co.jp/event/z/', '2027-05-20 10:00+09')$$, '55000', null, 'archived sale is not editable');
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-0000000000ff', now(), false, 'x', null, '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://www.rakuten.co.jp/event/a/', '2027-06-20 10:00+09')$$, 'P0002', null, 'missing sale reported as not found');
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', (select updated_at - interval '1 second' from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), false, 'Stale Save', null, '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://www.rakuten.co.jp/event/a/', '2027-06-20 10:00+09')$$, 'P0409', null, 'stale expected_updated_at rejected (P0409, never 40001)');
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', null, false, 'Null Expected', null, '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://www.rakuten.co.jp/event/a/', '2027-06-20 10:00+09')$$, '22023', null, 'missing expected_updated_at rejected');

-- duplicate
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), false, 'DUP  TARGET', null, '2027-08-01 00:00+09', '2027-08-02 00:00+09', true, 'https://www.rakuten.co.jp/event/a/', '2027-06-20 10:00+09')$$, '23505', null, 'edit colliding with an active sale rejected (23505)');

-- content validation
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), false, 'Edit Pending Fixed', null, '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://www.amazon.co.jp/event/a/', '2027-06-21 10:00+09')$$, '22023', null, 'another retailer''s official domain rejected');
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), false, 'Edit Pending Fixed', null, '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://prtimes.jp/main/html/rd/p/000009999.000022933.html', '2027-06-21 10:00+09')$$, '22023', null, 'Qoo10 manual source rejected for Rakuten');
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), false, 'Edit Pending Fixed', null, '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://evil-rakuten.co.jp/event/a/', '2027-06-21 10:00+09')$$, '22023', null, 'lookalike domain rejected');
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), false, 'Edit Pending Fixed', null, '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'http://www.rakuten.co.jp/event/b/', '2027-06-21 10:00+09')$$, '22023', null, 'http source rejected');
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), false, 'Edit Pending Fixed', null, '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://user:pass@www.rakuten.co.jp/event/b/', '2027-06-21 10:00+09')$$, '22023', null, 'credentials in source rejected');
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), false, 'Edit Pending Fixed', null, '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://www.rakuten.co.jp:443/event/b/', '2027-06-21 10:00+09')$$, '22023', null, 'explicit port rejected');
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), false, 'Edit Pending Fixed', null, '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://www.rakuten.co.jp/event/' || repeat('a', 2048), '2027-06-21 10:00+09')$$, '22023', null, 'over-long source rejected');
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), false, '　 ', null, '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://www.rakuten.co.jp/event/a/', '2027-06-20 10:00+09')$$, '22023', null, 'whitespace-only title rejected');
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), false, 'Edit Pending Fixed', repeat('x', 5001), '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://www.rakuten.co.jp/event/a/', '2027-06-20 10:00+09')$$, '22023', null, 'over-long description rejected');
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), false, 'Edit Pending Fixed', null, '2027-07-04 00:00+09', '2027-07-04 00:00+09', true, 'https://www.rakuten.co.jp/event/a/', '2027-06-20 10:00+09')$$, '22023', null, 'end not after start rejected');
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), false, 'Edit Pending Fixed', null, '2027-07-01 00:00+09', '2027-07-03 23:59+09', true, 'https://www.rakuten.co.jp/event/a/', '2027-06-20 10:00+09')$$, '22023', null, 'date-only period not at midnight rejected');

-- source URL change needs a newer checked time
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), false, 'Edit Pending Fixed', null, '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://www.rakuten.co.jp/event/b/', '2027-06-20 10:00+09')$$, '22023', null, 'new source URL with the same checked time rejected');
select throws_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), false, 'Edit Pending Fixed', null, '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://www.rakuten.co.jp/event/b/', '2027-06-19 10:00+09')$$, '22023', null, 'new source URL with an older checked time rejected');
select is((select row(title, source_url)::text from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), row('Edit Pending Fixed', 'https://www.rakuten.co.jp/event/a/')::text, 'rejected saves left the sale unchanged');
select lives_ok($$select public.update_sale_event('20000000-0000-4000-8000-000000000001', (select updated_at from public.sale_events where id = '20000000-0000-4000-8000-000000000001'), false, 'Edit Pending Fixed', null, '2027-07-01 00:00+09', '2027-07-04 00:00+09', true, 'https://www.rakuten.co.jp/event/b/', '2027-06-21 10:00+09')$$, 'new source URL with a newer checked time accepted');

-- lifecycle RPCs still work without the direct UPDATE privilege
select lives_ok($$select public.publish_sale_event('20000000-0000-4000-8000-000000000001')$$, 'publish RPC still works');
select lives_ok($$select public.archive_sale_event('20000000-0000-4000-8000-000000000001')$$, 'archive RPC still works');
select lives_ok($$select public.reopen_sale_event('20000000-0000-4000-8000-000000000003')$$, 'reopen RPC still works');
select lives_ok($$select public.reject_sale_event('20000000-0000-4000-8000-000000000005', 'テスト')$$, 'reject RPC still works');
reset role;

-- ============================================================
-- Owner checks
-- ============================================================

select is((select string_agg(status, ',' order by id) from public.sale_events where id::text like '20000000-%'), 'archived,published,pending_review,archived,rejected', 'final statuses come from lifecycle RPCs only');
select is((select count(*)::int from public.sale_event_audit a where a.action = 'update' and a.sale_event_id::text like '20000000-%'), 4, 'one update audit row per successful save');
select is((select count(*)::int from public.sale_event_audit a where a.action = 'update' and a.sale_event_id::text like '20000000-%' and a.actor_user_id is distinct from '00000000-0000-4000-8000-0000000f1a01'), 0, 'every update audit row names the admin');

select * from finish();
