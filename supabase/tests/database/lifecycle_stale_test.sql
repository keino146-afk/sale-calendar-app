-- pgTAP tests for stale-view protection of the lifecycle RPCs (Phase 6O).
-- Everything runs inside one transaction and is rolled back. now() is fixed
-- inside a transaction, so rows whose "loaded" updated_at must differ from
-- the post-transition value are inserted with an explicit older updated_at
-- (the updated_at trigger only runs on UPDATE); staleness is tested with a
-- deliberately different expected value.

begin;

create extension if not exists pgtap with schema extensions;

select plan(59);

-- ============================================================
-- Structure and grants
-- ============================================================

select has_function('public', 'publish_sale_event', array['uuid'], 'old publish(p_id) kept');
select has_function('public', 'reject_sale_event', array['uuid', 'text'], 'old reject(p_id, p_reason) kept');
select has_function('public', 'archive_sale_event', array['uuid'], 'old archive(p_id) kept');
select has_function('public', 'reopen_sale_event', array['uuid'], 'old reopen(p_id) kept');
select has_function('public', 'publish_sale_event', array['uuid', 'timestamp with time zone'], 'new publish(p_id, p_expected_updated_at)');
select has_function('public', 'reject_sale_event', array['uuid', 'text', 'timestamp with time zone'], 'new reject(p_id, p_reason, p_expected_updated_at)');
select has_function('public', 'archive_sale_event', array['uuid', 'timestamp with time zone'], 'new archive(p_id, p_expected_updated_at)');
select has_function('public', 'reopen_sale_event', array['uuid', 'timestamp with time zone'], 'new reopen(p_id, p_expected_updated_at)');

create temporary table new_rpcs (sig regprocedure) on commit drop;
insert into new_rpcs values
  ('public.publish_sale_event(uuid, timestamptz)'::regprocedure),
  ('public.reject_sale_event(uuid, text, timestamptz)'::regprocedure),
  ('public.archive_sale_event(uuid, timestamptz)'::regprocedure),
  ('public.reopen_sale_event(uuid, timestamptz)'::regprocedure);

select ok((select bool_and(p.pronargdefaults = 0) from pg_proc p join new_rpcs n on n.sig = p.oid), 'new overloads: p_expected_updated_at has no DEFAULT (unambiguous by argument names)');
select ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p join new_rpcs n on n.sig = p.oid), 'new overloads: SECURITY DEFINER with empty search_path');
select ok(not exists (select 1 from pg_proc p join new_rpcs n on n.sig = p.oid, aclexplode(p.proacl) a where a.grantee = 0), 'new overloads: no PUBLIC execute');
select ok((select bool_and(not has_function_privilege('anon', sig, 'execute')) from new_rpcs), 'new overloads: anon cannot execute');
select ok((select bool_and(has_function_privilege('authenticated', sig, 'execute')) from new_rpcs), 'new overloads: authenticated may execute (admin checked inside)');
select ok((select bool_and(p.pronargdefaults = 0) from pg_proc p where p.proname in ('publish_sale_event', 'reject_sale_event', 'archive_sale_event', 'reopen_sale_event') and p.pronamespace = 'public'::regnamespace), 'old overloads: no DEFAULT either');

select is(
  (select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'sale_events'),
  'id:uuid,retailer_id:uuid,title:text,description:text,starts_at:timestamp with time zone,ends_at:timestamp with time zone,is_date_only:boolean,status:text,source_url:text,source_checked_at:timestamp with time zone,published_at:timestamp with time zone,rejected_at:timestamp with time zone,archived_at:timestamp with time zone,title_key:text,start_date_jst:date,created_at:timestamp with time zone,updated_at:timestamp with time zone',
  'sale_events columns unchanged');
select is(
  (select string_agg(policyname, ',' order by policyname) from pg_policies where schemaname = 'public' and tablename = 'sale_events'),
  'sale_events_admin_insert,sale_events_admin_read,sale_events_admin_update,sale_events_public_published_read',
  'sale_events RLS policies unchanged');

-- ============================================================
-- Fixtures (owner context)
-- ============================================================

insert into auth.users (id, email, aud, role)
values
  ('00000000-0000-4000-8000-0000000f6a01', 'stale-admin@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000f6b01', 'stale-user@example.invalid', 'authenticated', 'authenticated');
insert into public.admin_users (user_id) values ('00000000-0000-4000-8000-0000000f6a01');

-- 01-04 stay pending_review with an older updated_at (publish/reject);
-- 05 becomes published, 06 rejected (their updated_at is now()).
-- 07-10 are for the original overloads.
insert into public.sale_events (id, retailer_id, title, starts_at, ends_at, is_date_only, source_url, source_checked_at, updated_at)
select v.id::uuid, (select id from public.retailers where slug = 'rakuten'), v.title,
       ('2027-09-' || v.d || ' 00:00+09')::timestamptz, ('2027-09-' || v.d || ' 00:00+09')::timestamptz + interval '1 day',
       true, 'https://www.rakuten.co.jp/event/s/', '2027-08-01 10:00+09', now() - interval '1 hour'
from (values
  ('30000000-0000-4000-8000-000000000001', 'Stale Publish', '01'),
  ('30000000-0000-4000-8000-000000000002', 'Stale Reject', '02'),
  ('30000000-0000-4000-8000-000000000003', 'Stale Pending Spare', '03'),
  ('30000000-0000-4000-8000-000000000004', 'Stale Pending Spare 2', '04'),
  ('30000000-0000-4000-8000-000000000005', 'Stale Archive', '05'),
  ('30000000-0000-4000-8000-000000000006', 'Stale Reopen', '06'),
  ('30000000-0000-4000-8000-000000000007', 'Old Publish', '07'),
  ('30000000-0000-4000-8000-000000000008', 'Old Reject', '08'),
  ('30000000-0000-4000-8000-000000000009', 'Old Archive', '09'),
  ('30000000-0000-4000-8000-000000000010', 'Old Reopen', '10')) as v(id, title, d);
update public.sale_events set status = 'published' where id in ('30000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000009');
update public.sale_events set status = 'rejected' where id in ('30000000-0000-4000-8000-000000000006', '30000000-0000-4000-8000-000000000010');

create temporary table loaded on commit drop as
select id, status, updated_at from public.sale_events where id::text like '30000000-%';
-- Callers read the "page" values from here inside throws_ok/lives_ok.
grant select on loaded to anon, authenticated;

-- ============================================================
-- Denied callers
-- ============================================================

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok($$select public.publish_sale_event('30000000-0000-4000-8000-000000000001', now())$$, '42501', null, 'anon: new publish denied');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000f6b01","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.publish_sale_event('30000000-0000-4000-8000-000000000001', (select updated_at from loaded where id = '30000000-0000-4000-8000-000000000001'))$$, '42501', 'insufficient privilege', 'non-admin: new publish fails the admin check');
select throws_ok($$select public.reject_sale_event('30000000-0000-4000-8000-000000000002', 'x', (select updated_at from loaded where id = '30000000-0000-4000-8000-000000000002'))$$, '42501', 'insufficient privilege', 'non-admin: new reject fails the admin check');
select throws_ok($$select public.archive_sale_event('30000000-0000-4000-8000-000000000005', (select updated_at from loaded where id = '30000000-0000-4000-8000-000000000005'))$$, '42501', 'insufficient privilege', 'non-admin: new archive fails the admin check');
select throws_ok($$select public.reopen_sale_event('30000000-0000-4000-8000-000000000006', (select updated_at from loaded where id = '30000000-0000-4000-8000-000000000006'))$$, '42501', 'insufficient privilege', 'non-admin: new reopen fails the admin check');
reset role;

select is((select count(*)::int from public.sale_events e join loaded l using (id) where e.status <> l.status or e.updated_at <> l.updated_at), 0, 'denied callers changed nothing');

-- ============================================================
-- Admin: stale, wrong status, fresh, repeat
-- ============================================================

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000f6a01","role":"authenticated"}', true);
set local role authenticated;

select throws_ok($$select public.publish_sale_event('30000000-0000-4000-8000-000000000001', null)$$, '22023', null, 'missing expected_updated_at rejected');

-- publish (pending_review -> published)
select throws_ok($$select public.publish_sale_event('30000000-0000-4000-8000-000000000001', (select updated_at - interval '1 second' from loaded where id = '30000000-0000-4000-8000-000000000001'))$$, 'P0409', null, 'publish: stale expected_updated_at -> P0409');
select throws_ok($$select public.publish_sale_event('30000000-0000-4000-8000-000000000005', (select updated_at from loaded where id = '30000000-0000-4000-8000-000000000005'))$$, 'P0002', null, 'publish: wrong status (published) -> P0002');
select throws_ok($$select public.publish_sale_event('30000000-0000-4000-8000-000000000005', (select updated_at - interval '1 second' from loaded where id = '30000000-0000-4000-8000-000000000005'))$$, 'P0002', null, 'publish: wrong status and stale -> status error first (P0002)');
select throws_ok($$select public.publish_sale_event('30000000-0000-4000-8000-0000000000ff', now())$$, 'P0002', null, 'publish: missing sale -> P0002');
select lives_ok($$select public.publish_sale_event('30000000-0000-4000-8000-000000000001', (select updated_at from loaded where id = '30000000-0000-4000-8000-000000000001'))$$, 'publish: fresh expected_updated_at succeeds');
select is((select row(e.status, e.published_at is not null, e.updated_at <> l.updated_at)::text from public.sale_events e join loaded l using (id) where id = '30000000-0000-4000-8000-000000000001'), row('published', true, true)::text, 'publish: published, published_at set, updated_at moved');
select is((select a.action || '|' || a.actor_user_id::text from public.sale_event_audit a where a.sale_event_id = '30000000-0000-4000-8000-000000000001' order by a.id desc limit 1), 'publish|00000000-0000-4000-8000-0000000f6a01', 'publish: audited once as publish by the admin');
select throws_ok($$select public.publish_sale_event('30000000-0000-4000-8000-000000000001', (select updated_at from loaded where id = '30000000-0000-4000-8000-000000000001'))$$, 'P0002', null, 'publish: same request again -> P0002 (already published)');

-- reject (pending_review -> rejected, reason in the audit note)
select throws_ok($$select public.reject_sale_event('30000000-0000-4000-8000-000000000002', 'reason', (select updated_at - interval '1 second' from loaded where id = '30000000-0000-4000-8000-000000000002'))$$, 'P0409', null, 'reject: stale expected_updated_at -> P0409');
select throws_ok($$select public.reject_sale_event('30000000-0000-4000-8000-000000000005', 'reason', (select updated_at from loaded where id = '30000000-0000-4000-8000-000000000005'))$$, 'P0002', null, 'reject: wrong status (published) -> P0002');
select throws_ok($$select public.reject_sale_event('30000000-0000-4000-8000-000000000005', 'reason', (select updated_at - interval '1 second' from loaded where id = '30000000-0000-4000-8000-000000000005'))$$, 'P0002', null, 'reject: wrong status and stale -> P0002');
select throws_ok($$select public.reject_sale_event('30000000-0000-4000-8000-000000000002', '   ', (select updated_at from loaded where id = '30000000-0000-4000-8000-000000000002'))$$, '22023', null, 'reject: blank reason still rejected');
select lives_ok($$select public.reject_sale_event('30000000-0000-4000-8000-000000000002', '　重複のため　', (select updated_at from loaded where id = '30000000-0000-4000-8000-000000000002'))$$, 'reject: fresh expected_updated_at succeeds');
select is((select row(e.status, e.rejected_at is not null, e.updated_at <> l.updated_at)::text from public.sale_events e join loaded l using (id) where id = '30000000-0000-4000-8000-000000000002'), row('rejected', true, true)::text, 'reject: rejected, rejected_at set, updated_at moved');
select is((select a.action || '|' || a.note from public.sale_event_audit a where a.sale_event_id = '30000000-0000-4000-8000-000000000002' order by a.id desc limit 1), 'reject|重複のため', 'reject: audited with the normalised reason');
select throws_ok($$select public.reject_sale_event('30000000-0000-4000-8000-000000000002', 'reason', (select updated_at from loaded where id = '30000000-0000-4000-8000-000000000002'))$$, 'P0002', null, 'reject: same request again -> P0002');

-- archive (published -> archived)
select throws_ok($$select public.archive_sale_event('30000000-0000-4000-8000-000000000005', (select updated_at - interval '1 second' from loaded where id = '30000000-0000-4000-8000-000000000005'))$$, 'P0409', null, 'archive: stale expected_updated_at -> P0409');
select throws_ok($$select public.archive_sale_event('30000000-0000-4000-8000-000000000003', (select updated_at from loaded where id = '30000000-0000-4000-8000-000000000003'))$$, 'P0002', null, 'archive: wrong status (pending_review) -> P0002');
select throws_ok($$select public.archive_sale_event('30000000-0000-4000-8000-000000000003', (select updated_at - interval '1 second' from loaded where id = '30000000-0000-4000-8000-000000000003'))$$, 'P0002', null, 'archive: wrong status and stale -> P0002');
select lives_ok($$select public.archive_sale_event('30000000-0000-4000-8000-000000000005', (select updated_at from loaded where id = '30000000-0000-4000-8000-000000000005'))$$, 'archive: fresh expected_updated_at succeeds');
select is((select row(status, archived_at is not null)::text from public.sale_events where id = '30000000-0000-4000-8000-000000000005'), row('archived', true)::text, 'archive: archived, archived_at set');
select is((select a.action from public.sale_event_audit a where a.sale_event_id = '30000000-0000-4000-8000-000000000005' order by a.id desc limit 1), 'archive', 'archive: audited as archive');
select throws_ok($$select public.archive_sale_event('30000000-0000-4000-8000-000000000005', (select updated_at from loaded where id = '30000000-0000-4000-8000-000000000005'))$$, 'P0002', null, 'archive: same request again -> P0002');

-- reopen (rejected -> pending_review)
select throws_ok($$select public.reopen_sale_event('30000000-0000-4000-8000-000000000006', (select updated_at - interval '1 second' from loaded where id = '30000000-0000-4000-8000-000000000006'))$$, 'P0409', null, 'reopen: stale expected_updated_at -> P0409');
select throws_ok($$select public.reopen_sale_event('30000000-0000-4000-8000-000000000004', (select updated_at from loaded where id = '30000000-0000-4000-8000-000000000004'))$$, 'P0002', null, 'reopen: wrong status (pending_review) -> P0002');
select throws_ok($$select public.reopen_sale_event('30000000-0000-4000-8000-000000000004', (select updated_at - interval '1 second' from loaded where id = '30000000-0000-4000-8000-000000000004'))$$, 'P0002', null, 'reopen: wrong status and stale -> P0002');
select lives_ok($$select public.reopen_sale_event('30000000-0000-4000-8000-000000000006', (select updated_at from loaded where id = '30000000-0000-4000-8000-000000000006'))$$, 'reopen: fresh expected_updated_at succeeds');
select is((select row(status, rejected_at is null)::text from public.sale_events where id = '30000000-0000-4000-8000-000000000006'), row('pending_review', true)::text, 'reopen: pending_review again, rejected_at cleared');
select is((select a.action from public.sale_event_audit a where a.sale_event_id = '30000000-0000-4000-8000-000000000006' order by a.id desc limit 1), 'reopen', 'reopen: audited as reopen');

-- Stale and wrong-status calls changed nothing on their own rows.
select is((select row(e.status, e.updated_at = l.updated_at)::text from public.sale_events e join loaded l using (id) where id = '30000000-0000-4000-8000-000000000003'), row('pending_review', true)::text, 'refused calls left the row untouched');

-- ============================================================
-- Original overloads keep their behaviour (older application)
-- ============================================================

select lives_ok($$select public.publish_sale_event('30000000-0000-4000-8000-000000000007')$$, 'old publish(p_id) still works');
select lives_ok($$select public.reject_sale_event('30000000-0000-4000-8000-000000000008', 'old reason')$$, 'old reject(p_id, p_reason) still works');
select lives_ok($$select public.archive_sale_event('30000000-0000-4000-8000-000000000009')$$, 'old archive(p_id) still works');
select lives_ok($$select public.reopen_sale_event('30000000-0000-4000-8000-000000000010')$$, 'old reopen(p_id) still works');
select is((select string_agg(status, ',' order by id) from public.sale_events where id in ('30000000-0000-4000-8000-000000000007', '30000000-0000-4000-8000-000000000008', '30000000-0000-4000-8000-000000000009', '30000000-0000-4000-8000-000000000010')), 'published,rejected,archived,pending_review', 'old overloads made their transitions');
select throws_ok($$select public.publish_sale_event('30000000-0000-4000-8000-000000000007')$$, 'P0002', null, 'old publish: wrong status still P0002');

reset role;

select * from finish();
rollback;
