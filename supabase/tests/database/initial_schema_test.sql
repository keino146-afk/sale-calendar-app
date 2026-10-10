-- pgTAP security and behavior tests for the initial schema migration.
-- Everything runs inside one transaction and is rolled back.
--
-- Role simulation: auth.uid() reads request.jwt.claim.sub, then
-- request.jwt.claims ->> 'sub'. Tests set request.jwt.claims (transaction
-- local) and switch with SET LOCAL ROLE; RESET ROLE returns to the owner.

begin;

create extension if not exists pgtap with schema extensions;

select plan(123);

-- ============================================================
-- Fixtures (owner context)
-- ============================================================

insert into auth.users (id, email, aud, role)
values
  ('00000000-0000-4000-8000-00000000a001', 'admin@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-00000000b001', 'user@example.invalid', 'authenticated', 'authenticated');

insert into public.admin_users (user_id)
values ('00000000-0000-4000-8000-00000000a001');

insert into public.retailers (id, slug, name, official_base_url, sort_order, is_active)
values ('20000000-0000-4000-8000-000000000001', 'test-inactive', 'Inactive Test Retailer',
        'https://inactive.example.invalid/', 99, false);

-- Fixture events: published / pending / rejected / archived.
insert into public.sale_events (id, retailer_id, title, starts_at, ends_at, source_url)
select v.id, r.id, v.title, v.starts_at, v.ends_at, 'https://www.rakuten.co.jp/'
from public.retailers r
cross join (values
  ('10000000-0000-4000-8000-000000000001'::uuid, 'Fixture Published', '2026-12-01 00:00+09'::timestamptz, '2026-12-02 00:00+09'::timestamptz),
  ('10000000-0000-4000-8000-000000000002'::uuid, 'Fixture Pending',   '2026-12-01 00:00+09'::timestamptz, '2026-12-02 00:00+09'::timestamptz),
  ('10000000-0000-4000-8000-000000000003'::uuid, 'Fixture Rejected',  '2026-12-01 00:00+09'::timestamptz, '2026-12-02 00:00+09'::timestamptz),
  ('10000000-0000-4000-8000-000000000004'::uuid, 'Fixture Archived',  '2026-12-01 00:00+09'::timestamptz, '2026-12-02 00:00+09'::timestamptz)
) as v (id, title, starts_at, ends_at)
where r.slug = 'rakuten';

update public.sale_events set status = 'published'
where id in ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004');
update public.sale_events set status = 'rejected'
where id = '10000000-0000-4000-8000-000000000003';
update public.sale_events set status = 'archived'
where id = '10000000-0000-4000-8000-000000000004';

-- ============================================================
-- Structural regression (RLS / policies / grants)
-- ============================================================

select ok(
  (select bool_and(relrowsecurity) from pg_class
   where oid in ('public.retailers'::regclass, 'public.sale_events'::regclass,
                 'public.admin_users'::regclass, 'public.sale_event_audit'::regclass)),
  'RLS is enabled on all 4 application tables'
);

select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'admin_users'),
  0, 'admin_users has no policies'
);

select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and cmd in ('DELETE', 'ALL')),
  0, 'no DELETE (or ALL) policies exist'
);

select ok(
  not (select bool_or(
         has_column_privilege(r, 'public.sale_events', c, 'INSERT')
         or has_column_privilege(r, 'public.sale_events', c, 'UPDATE'))
       from unnest(array['anon', 'authenticated']) r
       cross join unnest(array['id', 'status', 'published_at', 'rejected_at', 'archived_at',
                               'title_key', 'start_date_jst', 'created_at', 'updated_at']) c),
  'no anon/authenticated INSERT/UPDATE privilege on protected sale_events columns'
);

select ok(
  not (select bool_or(has_table_privilege(r, t, 'DELETE') or has_table_privilege(r, t, 'TRUNCATE'))
       from unnest(array['anon', 'authenticated']) r
       cross join unnest(array['public.retailers', 'public.sale_events',
                               'public.admin_users', 'public.sale_event_audit']) t),
  'no anon/authenticated DELETE/TRUNCATE on application tables'
);

select ok(
  not (select bool_or(has_table_privilege(r, 'public.sale_event_audit', p))
       from unnest(array['anon', 'authenticated']) r
       cross join unnest(array['INSERT', 'UPDATE', 'DELETE']) p),
  'no anon/authenticated write privilege on sale_event_audit'
);

select ok(
  not (select bool_or(has_table_privilege(r, 'public.admin_users', p))
       from unnest(array['anon', 'authenticated']) r
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p),
  'no anon/authenticated privilege on admin_users'
);

select ok(
  not (select bool_or(has_function_privilege('anon', f, 'EXECUTE'))
       from unnest(array['private.is_admin()', 'private.set_sale_event_derived()',
                         'private.enforce_sale_event_transition()', 'private.set_updated_at()',
                         'private.log_sale_event_change()', 'public.publish_sale_event(uuid)',
                         'public.reject_sale_event(uuid,text)', 'public.archive_sale_event(uuid)',
                         'public.reopen_sale_event(uuid)']) f),
  'anon cannot execute any schema function'
);

select ok(
  not (select bool_or(has_function_privilege('authenticated', f, 'EXECUTE'))
       from unnest(array['private.set_sale_event_derived()', 'private.enforce_sale_event_transition()',
                         'private.set_updated_at()', 'private.log_sale_event_change()']) f),
  'authenticated cannot directly execute trigger functions'
);

select ok(
  not has_schema_privilege('anon', 'private', 'USAGE'),
  'anon has no USAGE on private schema'
);

-- ============================================================
-- Title normalization and JST date derivation (owner context)
-- ============================================================

insert into public.sale_events (id, retailer_id, title, starts_at, ends_at, source_url)
select '10000000-0000-4000-8000-000000000010', id, 'Ｓｕｐｅｒ　SALE  テスト',
       '2026-11-01 00:30:00+09', '2026-11-03 00:00:00+09', 'https://www.rakuten.co.jp/'
from public.retailers where slug = 'rakuten';

select is(
  (select title_key from public.sale_events where id = '10000000-0000-4000-8000-000000000010'),
  'supersaleテスト', 'title_key = NFKC + lower + all whitespace (incl. full-width) removed'
);

select is(
  (select start_date_jst from public.sale_events where id = '10000000-0000-4000-8000-000000000010'),
  '2026-11-01'::date, 'start_date_jst uses JST date (00:30 JST)'
);

select is(
  (select (starts_at at time zone 'UTC')::date from public.sale_events
   where id = '10000000-0000-4000-8000-000000000010'),
  '2026-10-31'::date, 'the same timestamp falls on the previous UTC date'
);

insert into public.sale_events (id, retailer_id, title, starts_at, ends_at, source_url)
select '10000000-0000-4000-8000-000000000011', id, 'JST Late Night Event',
       '2026-10-31 23:59:59+09', '2026-11-01 01:00:00+09', 'https://www.amazon.co.jp/'
from public.retailers where slug = 'amazon';

select is(
  (select start_date_jst from public.sale_events where id = '10000000-0000-4000-8000-000000000011'),
  '2026-10-31'::date, 'start_date_jst uses JST date (23:59:59 JST)'
);

-- ============================================================
-- Basic constraints (owner context)
-- ============================================================

select throws_ok(
  $$insert into public.sale_events (retailer_id, title, starts_at, ends_at, source_url)
    select id, '　 　', '2027-02-01 00:00+09', '2027-02-02 00:00+09', 'https://www.rakuten.co.jp/'
    from public.retailers where slug = 'rakuten'$$,
  '23514', null, 'whitespace-only title is rejected'
);

select throws_ok(
  $$insert into public.sale_events (retailer_id, title, starts_at, ends_at, source_url)
    select id, 'Bad Range', '2027-02-01 00:00+09', '2027-02-01 00:00+09', 'https://www.rakuten.co.jp/'
    from public.retailers where slug = 'rakuten'$$,
  '23514', null, 'ends_at <= starts_at is rejected'
);

select throws_ok(
  $$insert into public.sale_events (retailer_id, title, starts_at, ends_at, source_url, status)
    select id, 'Bad Status', '2027-02-01 00:00+09', '2027-02-02 00:00+09', 'https://www.rakuten.co.jp/', 'draft'
    from public.retailers where slug = 'rakuten'$$,
  '23514', null, 'invalid status is rejected'
);

select throws_ok(
  $$insert into public.sale_events (retailer_id, title, starts_at, ends_at, source_url)
    select id, 'Bad URL', '2027-02-01 00:00+09', '2027-02-02 00:00+09', 'http://www.rakuten.co.jp/'
    from public.retailers where slug = 'rakuten'$$,
  '23514', null, 'http:// source_url is rejected'
);

select throws_ok(
  $$insert into public.sale_events (retailer_id, title, description, starts_at, ends_at, source_url)
    select id, 'Long Description', repeat('a', 5001), '2027-02-01 00:00+09', '2027-02-02 00:00+09',
           'https://www.rakuten.co.jp/'
    from public.retailers where slug = 'rakuten'$$,
  '23514', null, 'description longer than 5000 characters is rejected'
);

select throws_ok(
  $$insert into public.retailers (slug, name, official_base_url) values ('　', 'Blank Slug', 'https://x.example.invalid/')$$,
  '23514', null, 'retailers: full-width-space-only slug is rejected'
);
select throws_ok(
  $$insert into public.retailers (slug, name, official_base_url) values (E'\t\n', 'Blank Slug', 'https://x.example.invalid/')$$,
  '23514', null, 'retailers: tab/newline-only slug is rejected'
);
select throws_ok(
  $$insert into public.retailers (slug, name, official_base_url) values ('blank-name-1', '　', 'https://x.example.invalid/')$$,
  '23514', null, 'retailers: full-width-space-only name is rejected'
);
select throws_ok(
  $$insert into public.retailers (slug, name, official_base_url) values ('blank-name-2', E' \t\n　', 'https://x.example.invalid/')$$,
  '23514', null, 'retailers: mixed Unicode-whitespace-only name is rejected'
);
select is(
  (select string_agg(slug || '|' || name || '|' || official_base_url || '|' || sort_order || '|' || is_active, ',' order by sort_order)
   from public.retailers where slug in ('rakuten', 'amazon', 'qoo10')),
  'rakuten|楽天市場|https://www.rakuten.co.jp/|10|true,amazon|Amazon|https://www.amazon.co.jp/|20|true,qoo10|Qoo10|https://www.qoo10.jp/|30|true',
  'retailers: the 3 seed rows are present and valid'
);

-- ============================================================
-- Invalid transitions are rejected by the trigger (owner context)
-- ============================================================

select throws_ok(
  $$update public.sale_events set status = 'archived'
    where id = '10000000-0000-4000-8000-000000000002'$$,
  '55000', null, 'pending_review -> archived is rejected by the transition trigger'
);

select throws_ok(
  $$update public.sale_events set status = 'published'
    where id = '10000000-0000-4000-8000-000000000003'$$,
  '55000', null, 'rejected -> published is rejected by the transition trigger'
);

-- ============================================================
-- Dedup (owner context)
-- ============================================================

select throws_ok(
  $$insert into public.sale_events (retailer_id, title, starts_at, ends_at, source_url)
    select id, 'super sale テスト', '2026-11-01 20:00+09', '2026-11-02 00:00+09', 'https://www.rakuten.co.jp/'
    from public.retailers where slug = 'rakuten'$$,
  '23505', null, 'duplicate pending_review (same retailer + normalized title + JST date) is rejected'
);

-- R = rejected, P = pending_review with the same dedup key.
insert into public.sale_events (id, retailer_id, title, starts_at, ends_at, source_url)
select '10000000-0000-4000-8000-000000000020', id, 'Dedup Rejected Event',
       '2027-03-01 10:00+09', '2027-03-02 00:00+09', 'https://www.qoo10.jp/'
from public.retailers where slug = 'qoo10';

update public.sale_events set status = 'rejected'
where id = '10000000-0000-4000-8000-000000000020';

select lives_ok(
  $$insert into public.sale_events (id, retailer_id, title, starts_at, ends_at, source_url)
    select '10000000-0000-4000-8000-000000000021', id, 'dedup rejected event',
           '2027-03-01 18:00+09', '2027-03-02 00:00+09', 'https://www.qoo10.jp/'
    from public.retailers where slug = 'qoo10'$$,
  'pending_review insert succeeds while a rejected row has the same dedup key'
);

-- Collision fixtures: A2 published, B2 pending, different titles, same JST date.
insert into public.sale_events (id, retailer_id, title, starts_at, ends_at, source_url)
select v.id, r.id, v.title, v.starts_at, '2027-01-11 00:00+09', 'https://www.amazon.co.jp/'
from public.retailers r
cross join (values
  ('10000000-0000-4000-8000-000000000030'::uuid, 'Collision Published', '2027-01-10 10:00+09'::timestamptz),
  ('10000000-0000-4000-8000-000000000031'::uuid, 'Collision Pending',   '2027-01-10 12:00+09'::timestamptz)
) as v (id, title, starts_at)
where r.slug = 'amazon';

update public.sale_events set status = 'published'
where id = '10000000-0000-4000-8000-000000000030';

-- ============================================================
-- anon
-- ============================================================

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;

select is(auth.uid(), null::uuid, 'anon: auth.uid() is null');

select is(
  (select count(*)::int from public.retailers where slug in ('rakuten', 'amazon', 'qoo10')),
  3, 'anon: active retailers are readable'
);
select is(
  (select count(*)::int from public.retailers where slug = 'test-inactive'),
  0, 'anon: inactive retailer is hidden'
);
select is(
  (select count(*)::int from public.sale_events where id = '10000000-0000-4000-8000-000000000001'),
  1, 'anon: published event is readable'
);
select is(
  (select count(*)::int from public.sale_events where id = '10000000-0000-4000-8000-000000000002'),
  0, 'anon: pending_review event is hidden'
);
select is(
  (select count(*)::int from public.sale_events where id = '10000000-0000-4000-8000-000000000003'),
  0, 'anon: rejected event is hidden'
);
select is(
  (select count(*)::int from public.sale_events where id = '10000000-0000-4000-8000-000000000004'),
  0, 'anon: archived event is hidden'
);
select ok(
  (select bool_and(status = 'published') from public.sale_events),
  'anon: every visible event is published'
);

select throws_ok('select * from public.admin_users', '42501', null,
  'anon: admin_users select is denied');
select throws_ok('select * from public.sale_event_audit', '42501', null,
  'anon: sale_event_audit select is denied');

select throws_ok(
  $$insert into public.sale_events (retailer_id, title, starts_at, ends_at, source_url)
    values ((select id from public.retailers where slug = 'rakuten'), 'Anon Insert',
            '2027-04-01 00:00+09', '2027-04-02 00:00+09', 'https://www.rakuten.co.jp/')$$,
  '42501', null, 'anon: sale_events insert is denied'
);
select throws_ok(
  $$update public.sale_events set title = 'Anon Update'
    where id = '10000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'anon: sale_events update is denied'
);
select throws_ok(
  $$delete from public.sale_events where id = '10000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'anon: sale_events delete is denied'
);

select throws_ok($$select public.publish_sale_event('10000000-0000-4000-8000-000000000002')$$,
  '42501', 'permission denied for function publish_sale_event', 'anon: publish RPC execute is denied');
select throws_ok($$select public.reject_sale_event('10000000-0000-4000-8000-000000000002', 'x')$$,
  '42501', 'permission denied for function reject_sale_event', 'anon: reject RPC execute is denied');
select throws_ok($$select public.archive_sale_event('10000000-0000-4000-8000-000000000001')$$,
  '42501', 'permission denied for function archive_sale_event', 'anon: archive RPC execute is denied');
select throws_ok($$select public.reopen_sale_event('10000000-0000-4000-8000-000000000003')$$,
  '42501', 'permission denied for function reopen_sale_event', 'anon: reopen RPC execute is denied');

reset role;

-- ============================================================
-- authenticated non-admin
-- ============================================================

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000b001","role":"authenticated"}', true);
set local role authenticated;

select is(auth.uid(), '00000000-0000-4000-8000-00000000b001'::uuid,
  'non-admin: auth.uid() is the non-admin user');

select is(
  (select count(*)::int from public.sale_events where id = '10000000-0000-4000-8000-000000000001'),
  1, 'non-admin: published event is readable'
);
select is(
  (select count(*)::int from public.sale_events
   where id in ('10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003',
                '10000000-0000-4000-8000-000000000004')),
  0, 'non-admin: pending/rejected/archived events are hidden'
);
select ok(
  (select bool_and(status = 'published') from public.sale_events),
  'non-admin: every visible event is published'
);
select is(
  (select count(*)::int from public.retailers where slug = 'test-inactive'),
  0, 'non-admin: inactive retailer is hidden'
);
select is(
  (select count(*)::int from public.sale_event_audit),
  0, 'non-admin: sale_event_audit returns 0 rows (RLS)'
);
select throws_ok('select * from public.admin_users', '42501', null,
  'non-admin: admin_users select is denied');

select throws_ok(
  $$insert into public.sale_events (retailer_id, title, starts_at, ends_at, source_url)
    values ((select id from public.retailers where slug = 'rakuten'), 'Non-admin Insert',
            '2027-04-01 00:00+09', '2027-04-02 00:00+09', 'https://www.rakuten.co.jp/')$$,
  '42501', null, 'non-admin: sale_events insert is rejected by RLS'
);

-- RLS hides the row from UPDATE, so this affects 0 rows (checked below as owner).
select lives_ok(
  $$update public.sale_events set title = 'Non-admin Update'
    where id = '10000000-0000-4000-8000-000000000001'$$,
  'non-admin: content update statement runs but matches no rows'
);

select throws_ok(
  $$update public.sale_events set status = 'archived'
    where id = '10000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'non-admin: direct status update is denied'
);

select throws_ok($$select public.publish_sale_event('10000000-0000-4000-8000-000000000002')$$,
  '42501', 'insufficient privilege', 'non-admin: publish RPC fails the admin check');
select throws_ok($$select public.reject_sale_event('10000000-0000-4000-8000-000000000002', 'x')$$,
  '42501', 'insufficient privilege', 'non-admin: reject RPC fails the admin check');
select throws_ok($$select public.archive_sale_event('10000000-0000-4000-8000-000000000001')$$,
  '42501', 'insufficient privilege', 'non-admin: archive RPC fails the admin check');
select throws_ok($$select public.reopen_sale_event('10000000-0000-4000-8000-000000000003')$$,
  '42501', 'insufficient privilege', 'non-admin: reopen RPC fails the admin check');

reset role;

select is(
  (select title from public.sale_events where id = '10000000-0000-4000-8000-000000000001'),
  'Fixture Published', 'non-admin: published row is unchanged after the update attempt'
);
select is(
  (select status from public.sale_events where id = '10000000-0000-4000-8000-000000000002'),
  'pending_review', 'non-admin: pending row is unchanged after RPC attempts'
);

-- ============================================================
-- authenticated admin
-- ============================================================

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000a001","role":"authenticated"}', true);
set local role authenticated;

select is(auth.uid(), '00000000-0000-4000-8000-00000000a001'::uuid,
  'admin: auth.uid() is the admin user');

select is(
  (select count(*)::int from public.retailers
   where slug in ('rakuten', 'amazon', 'qoo10', 'test-inactive')),
  4, 'admin: active and inactive retailers are readable'
);
select is(
  (select count(*)::int from public.sale_events
   where id in ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002',
                '10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004')),
  4, 'admin: published/pending/rejected/archived events are readable'
);
select ok(
  (select count(*) > 0 from public.sale_event_audit),
  'admin: sale_event_audit is readable'
);
select throws_ok('select * from public.admin_users', '42501', null,
  'admin: admin_users direct select is still denied');

-- Content insert with the 8 allowed columns only.
select lives_ok(
  $$insert into public.sale_events
      (retailer_id, title, description, starts_at, ends_at, is_date_only, source_url, source_checked_at)
    values ((select id from public.retailers where slug = 'rakuten'), 'Admin Lifecycle Event',
            'Public description', '2027-05-01 00:00+09', '2027-05-03 00:00+09', true,
            'https://www.rakuten.co.jp/event/', now())$$,
  'admin: insert with the 8 allowed columns succeeds'
);

select is(
  (select status from public.sale_events where title = 'Admin Lifecycle Event'),
  'pending_review', 'admin insert: status defaults to pending_review'
);
select is(
  (select title_key || '|' || start_date_jst::text from public.sale_events
   where title = 'Admin Lifecycle Event'),
  'adminlifecycleevent|2027-05-01', 'admin insert: title_key and start_date_jst are derived'
);
select is(
  (select a.action || '|' || a.actor_user_id::text || '|' || coalesce(a.note, '<null>')
   from public.sale_event_audit a join public.sale_events e on e.id = a.sale_event_id
   where e.title = 'Admin Lifecycle Event' order by a.id desc limit 1),
  'create|00000000-0000-4000-8000-00000000a001|<null>', 'admin insert: create audit with admin actor and null note'
);

select lives_ok(
  $$update public.sale_events set description = 'Updated public description'
    where title = 'Admin Lifecycle Event'$$,
  'admin: content update succeeds'
);
select is(
  (select a.action || '|' || a.actor_user_id::text || '|' || coalesce(a.note, '<null>')
   from public.sale_event_audit a join public.sale_events e on e.id = a.sale_event_id
   where e.title = 'Admin Lifecycle Event' order by a.id desc limit 1),
  'update|00000000-0000-4000-8000-00000000a001|<null>', 'admin update: update audit with admin actor and null note'
);

-- Protected columns cannot be written even by an admin.
select throws_ok(
  $$update public.sale_events set status = 'published' where title = 'Admin Lifecycle Event'$$,
  '42501', null, 'admin: direct status update is denied'
);
select throws_ok(
  $$update public.sale_events set title_key = 'forged' where title = 'Admin Lifecycle Event'$$,
  '42501', null, 'admin: direct title_key update is denied'
);
select throws_ok(
  $$update public.sale_events set published_at = now() where title = 'Admin Lifecycle Event'$$,
  '42501', null, 'admin: direct published_at update is denied'
);
select throws_ok(
  $$update public.sale_events set start_date_jst = '2000-01-01' where title = 'Admin Lifecycle Event'$$,
  '42501', null, 'admin: direct start_date_jst update is denied'
);
select throws_ok(
  $$insert into public.sale_events (retailer_id, title, starts_at, ends_at, source_url, status)
    values ((select id from public.retailers where slug = 'rakuten'), 'Forged Status',
            '2027-04-01 00:00+09', '2027-04-02 00:00+09', 'https://www.rakuten.co.jp/', 'published')$$,
  '42501', null, 'admin: insert with status column is denied'
);

-- Publish.
select lives_ok(
  $$select public.publish_sale_event((select id from public.sale_events where title = 'Admin Lifecycle Event'))$$,
  'admin: publish RPC succeeds'
);
select ok(
  (select status = 'published' and published_at is not null and rejected_at is null and archived_at is null
   from public.sale_events where title = 'Admin Lifecycle Event'),
  'publish: status/timestamps are published state'
);
select is(
  (select a.action || '|' || a.actor_user_id::text || '|' || coalesce(a.note, '<null>')
   from public.sale_event_audit a join public.sale_events e on e.id = a.sale_event_id
   where e.title = 'Admin Lifecycle Event' order by a.id desc limit 1),
  'publish|00000000-0000-4000-8000-00000000a001|<null>', 'publish: audit action publish, null note'
);

select set_config('test.published_at',
  (select published_at::text from public.sale_events where title = 'Admin Lifecycle Event'), true);

-- Archive.
select lives_ok(
  $$select public.archive_sale_event((select id from public.sale_events where title = 'Admin Lifecycle Event'))$$,
  'admin: archive RPC succeeds'
);
select ok(
  (select status = 'archived' and archived_at is not null and rejected_at is null
          and published_at = current_setting('test.published_at')::timestamptz
   from public.sale_events where title = 'Admin Lifecycle Event'),
  'archive: archived_at set, published_at preserved, rejected_at null'
);
select is(
  (select a.action || '|' || a.actor_user_id::text || '|' || coalesce(a.note, '<null>')
   from public.sale_event_audit a join public.sale_events e on e.id = a.sale_event_id
   where e.title = 'Admin Lifecycle Event' order by a.id desc limit 1),
  'archive|00000000-0000-4000-8000-00000000a001|<null>', 'archive: audit action archive, null note'
);

-- Archived immutability.
select throws_ok(
  $$update public.sale_events set description = 'Edit after archive'
    where title = 'Admin Lifecycle Event'$$,
  '55000', null, 'admin: content edit on archived event fails with 55000'
);
select throws_ok(
  $$select public.archive_sale_event((select id from public.sale_events where title = 'Admin Lifecycle Event'))$$,
  'P0002', null, 'admin: archiving an already archived event fails with P0002'
);
select is(
  (select description from public.sale_events where title = 'Admin Lifecycle Event'),
  'Updated public description', 'archived event content is unchanged'
);

-- Reject flow.
select lives_ok(
  $$insert into public.sale_events (retailer_id, title, starts_at, ends_at, source_url)
    values ((select id from public.retailers where slug = 'amazon'), 'Admin Reject Event',
            '2027-06-01 00:00+09', '2027-06-02 00:00+09', 'https://www.amazon.co.jp/')$$,
  'admin: insert reject-flow event'
);

select throws_ok(
  $$select public.reject_sale_event((select id from public.sale_events where title = 'Admin Reject Event'), null)$$,
  '22023', null, 'reject: NULL reason fails with 22023'
);
select throws_ok(
  $$select public.reject_sale_event((select id from public.sale_events where title = 'Admin Reject Event'), '')$$,
  '22023', null, 'reject: empty reason fails with 22023'
);
select throws_ok(
  $$select public.reject_sale_event((select id from public.sale_events where title = 'Admin Reject Event'), '   ')$$,
  '22023', null, 'reject: ASCII-space-only reason fails with 22023'
);
select throws_ok(
  $$select public.reject_sale_event((select id from public.sale_events where title = 'Admin Reject Event'), '　　')$$,
  '22023', null, 'reject: full-width-space-only reason fails with 22023'
);
select throws_ok(
  $$select public.reject_sale_event((select id from public.sale_events where title = 'Admin Reject Event'), E'\t\n\r\n')$$,
  '22023', null, 'reject: tab/newline-only reason fails with 22023'
);
select throws_ok(
  $$select public.reject_sale_event((select id from public.sale_events where title = 'Admin Reject Event'), E'   　 \t\n')$$,
  '22023', null, 'reject: mixed Unicode-whitespace-only reason fails with 22023'
);
select throws_ok(
  $$select public.reject_sale_event((select id from public.sale_events where title = 'Admin Reject Event'), repeat('あ', 2001))$$,
  '22023', null, 'reject: 2001-character reason fails with 22023'
);
select is(
  (select status from public.sale_events where title = 'Admin Reject Event'),
  'pending_review', 'reject validation failures leave status pending_review'
);
select is(
  (select count(*)::int from public.sale_event_audit a join public.sale_events e on e.id = a.sale_event_id
   where e.title = 'Admin Reject Event' and a.action = 'reject'),
  0, 'reject validation failures create no reject audit row'
);

select lives_ok(
  $$select public.reject_sale_event((select id from public.sale_events where title = 'Admin Reject Event'), E'　 \tテスト 却下理由 \t\n　')$$,
  'admin: reject RPC succeeds with leading/trailing mixed whitespace'
);
select ok(
  (select status = 'rejected' and published_at is null and rejected_at is not null and archived_at is null
   from public.sale_events where title = 'Admin Reject Event'),
  'reject: status/timestamps are rejected state'
);
select is(
  (select a.action || '|' || a.actor_user_id::text || '|' || coalesce(a.note, '<null>')
   from public.sale_event_audit a join public.sale_events e on e.id = a.sale_event_id
   where e.title = 'Admin Reject Event' order by a.id desc limit 1),
  'reject|00000000-0000-4000-8000-00000000a001|テスト 却下理由', 'reject: audit note is the Unicode-trimmed reason'
);
select ok(
  (select a.note = 'テスト 却下理由' and position(' ' in a.note) = 4
   from public.sale_event_audit a join public.sale_events e on e.id = a.sale_event_id
   where e.title = 'Admin Reject Event' and a.action = 'reject'),
  'reject: internal whitespace in the reason is preserved'
);
select ok(
  not exists (
    select 1 from public.sale_events e
    where e.title = 'Admin Reject Event' and to_jsonb(e)::text like '%却下理由%'),
  'reject: reason is not stored on the sale_events row'
);

-- Same transaction, after reject: content edit on the rejected row (no RPC clears the note).
select lives_ok(
  $$update public.sale_events set description = 'Edited while rejected'
    where title = 'Admin Reject Event'$$,
  'admin: content edit on rejected event succeeds'
);
select is(
  (select a.action || '|' || coalesce(a.note, '<null>')
   from public.sale_event_audit a join public.sale_events e on e.id = a.sale_event_id
   where e.title = 'Admin Reject Event' order by a.id desc limit 1),
  'update|<null>', 'update after reject in same transaction has null note'
);

-- Reopen.
select lives_ok(
  $$select public.reopen_sale_event((select id from public.sale_events where title = 'Admin Reject Event'))$$,
  'admin: reopen RPC succeeds'
);
select ok(
  (select status = 'pending_review' and published_at is null and rejected_at is null and archived_at is null
   from public.sale_events where title = 'Admin Reject Event'),
  'reopen: status/timestamps are pending_review state'
);
select is(
  (select a.action || '|' || a.actor_user_id::text || '|' || coalesce(a.note, '<null>')
   from public.sale_event_audit a join public.sale_events e on e.id = a.sale_event_id
   where e.title = 'Admin Reject Event' order by a.id desc limit 1),
  'reopen|00000000-0000-4000-8000-00000000a001|<null>', 'reopen: audit note is null (no reject reason leak)'
);

-- Publish after reopen, still in the same transaction.
select lives_ok(
  $$select public.publish_sale_event((select id from public.sale_events where title = 'Admin Reject Event'))$$,
  'admin: publish after reopen succeeds'
);

select is(
  (select string_agg(a.action || ':' || coalesce(a.note, '<null>'), ',' order by a.id)
   from public.sale_event_audit a join public.sale_events e on e.id = a.sale_event_id
   where e.title = 'Admin Reject Event'),
  'create:<null>,reject:テスト 却下理由,update:<null>,reopen:<null>,publish:<null>',
  'cross-action: only the reject audit row carries a note'
);
select is(
  (select count(*)::int from public.sale_event_audit
   where note is not null and action <> 'reject'),
  0, 'cross-action: no non-reject audit row anywhere has a note'
);

-- Rejected rows are excluded from dedup: editing R (rejected) to a key that
-- matches active P does not raise 23505.
select lives_ok(
  $$update public.sale_events set title = 'DEDUP  REJECTED  EVENT', starts_at = '2027-03-01 11:00+09'
    where id = '10000000-0000-4000-8000-000000000020'$$,
  'rejected row content edit to an active dedup key does not raise 23505'
);
select is(
  (select status from public.sale_events where id = '10000000-0000-4000-8000-000000000020'),
  'rejected', 'edited rejected row stays rejected'
);

select set_config('test.r_rejected_at',
  (select rejected_at::text from public.sale_events where id = '10000000-0000-4000-8000-000000000020'), true);

select throws_ok(
  $$select public.reopen_sale_event('10000000-0000-4000-8000-000000000020')$$,
  '23505', null, 'reopen colliding with an active pending_review row fails with 23505'
);
select ok(
  (select status = 'rejected' and rejected_at = current_setting('test.r_rejected_at')::timestamptz
   from public.sale_events where id = '10000000-0000-4000-8000-000000000020'),
  'failed reopen: row stays rejected with rejected_at preserved'
);
select is(
  (select count(*)::int from public.sale_event_audit
   where sale_event_id = '10000000-0000-4000-8000-000000000020' and action = 'reopen'),
  0, 'failed reopen: no reopen audit row'
);

-- Published content edit collision.
select throws_ok(
  $$update public.sale_events set title = 'Collision Pending'
    where id = '10000000-0000-4000-8000-000000000030'$$,
  '23505', null, 'published content edit colliding with an active row fails with 23505'
);
select is(
  (select title || '|' || status from public.sale_events where id = '10000000-0000-4000-8000-000000000030'),
  'Collision Published|published', 'collided published row is unchanged'
);

-- Pending content edit collision.
select throws_ok(
  $$update public.sale_events set title = 'collision published'
    where id = '10000000-0000-4000-8000-000000000031'$$,
  '23505', null, 'pending_review content edit colliding with an active row fails with 23505'
);

-- Audit is read-only even for admins.
select throws_ok(
  $$insert into public.sale_event_audit (sale_event_id, action)
    values ('10000000-0000-4000-8000-000000000001', 'update')$$,
  '42501', null, 'admin: direct audit insert is denied'
);
select throws_ok(
  $$update public.sale_event_audit set note = 'forged'$$,
  '42501', null, 'admin: direct audit update is denied'
);
select throws_ok(
  $$delete from public.sale_event_audit$$,
  '42501', null, 'admin: direct audit delete is denied'
);

-- Deletes are not allowed (archive only).
select throws_ok(
  $$delete from public.sale_events where id = '10000000-0000-4000-8000-000000000002'$$,
  '42501', null, 'admin: sale_events delete is denied'
);
select throws_ok(
  $$delete from public.retailers where slug = 'test-inactive'$$,
  '42501', null, 'admin: retailers delete is denied'
);
select throws_ok(
  $$update public.retailers set name = 'Forged' where slug = 'rakuten'$$,
  '42501', null, 'admin: retailers update is denied'
);

reset role;

select * from finish();

rollback;
