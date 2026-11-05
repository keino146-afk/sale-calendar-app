-- pgTAP tests for sendable_since on push device registrations (roadmap 3,
-- C2). Everything runs inside one transaction and is rolled back, including
-- the temporary replacements of private.push_registration_intake_open(),
-- private.push_token_change_open() (to test the open paths) and
-- private.push_registration_current_time() (to fix the time); the
-- migration's state is checked first. Tokens and secrets are dummy values;
-- registration n has the secret lpad('n', 64, '0'). One transaction cannot
-- test real concurrency; that is checked separately.

begin;

create extension if not exists pgtap with schema extensions;

select plan(56);

-- ============================================================
-- Structure, triggers and grants (state right after the migration)
-- ============================================================

select is(
  (select data_type || ':' || is_nullable || ':' || coalesce(column_default, 'no default')
   from information_schema.columns
   where table_schema = 'private' and table_name = 'push_device_registrations' and column_name = 'sendable_since'),
  'timestamp with time zone:YES:no default',
  'sendable_since is a nullable timestamptz without a default');
select ok(exists (select 1 from pg_constraint
                  where conrelid = 'private.push_device_registrations'::regclass
                    and conname = 'push_device_registrations_sendable_since_after_created' and contype = 'c'),
          'the check constraint on sendable_since exists');
select is(
  (select string_agg(tgname || ':' || tgtype::text, ',' order by tgname)
   from pg_trigger where tgrelid = 'private.push_device_registrations'::regclass and not tgisinternal),
  'push_device_registrations_10_sendable_since:7,push_device_registrations_20_transition:19,push_device_registrations_30_updated_at:19',
  'triggers: 10 before insert (row), 20 and 30 before update (row), in name order');
select ok((select bool_and(not prosecdef and proconfig @> array['search_path=""']) from pg_proc
           where oid in ('private.set_push_registration_sendable_since()'::regprocedure,
                         'private.enforce_push_device_registration_transition()'::regprocedure)),
          'the insert trigger function and the transition guard are SECURITY INVOKER with empty search_path');
select ok(not (select bool_or(has_function_privilege(r, f, 'execute'))
               from unnest(array['public','anon','authenticated','service_role']) r,
                    unnest(array['private.set_push_registration_sendable_since()',
                                 'private.enforce_push_device_registration_transition()']) f),
          'neither trigger function is executable by client roles');
select ok((select bool_and(strpos(prosrc, 'push_device_registrations') = 0 and strpos(prosrc, 'push_registration_requests') = 0)
           from pg_proc
           where oid in ('private.set_push_registration_sendable_since()'::regprocedure,
                         'private.enforce_push_device_registration_transition()'::regprocedure)),
          'the trigger functions do not name the registration tables in their source');
select ok((select count(*) = 2 and bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc
           where oid in ('public.confirm_push_registration(text, text, text)'::regprocedure,
                         'public.confirm_push_token_change(text, text, text, text)'::regprocedure)),
          'the two confirmation RPCs are still SECURITY DEFINER with empty search_path');
select ok((select bool_and(has_function_privilege('anon', f, 'execute')
                           and not has_function_privilege('public', f, 'execute')
                           and not has_function_privilege('authenticated', f, 'execute')
                           and not has_function_privilege('service_role', f, 'execute'))
           from unnest(array['public.confirm_push_registration(text, text, text)',
                             'public.confirm_push_token_change(text, text, text, text)']) f),
          'the two confirmation RPCs are still executable by anon only');
select is(pg_catalog.pg_get_function_result('public.confirm_push_registration(text, text, text)'::regprocedure),
          'TABLE(ok boolean, registration_id uuid, registration_secret text, expires_at timestamp with time zone)',
          'confirm_push_registration still returns (ok, registration_id, registration_secret, expires_at)');
select is(pg_catalog.pg_get_function_result('public.confirm_push_token_change(text, text, text, text)'::regprocedure),
          'TABLE(ok boolean, confirmed_token_generation integer, expires_at timestamp with time zone)',
          'confirm_push_token_change still returns (ok, confirmed_token_generation, expires_at)');
select ok((select relrowsecurity from pg_class where oid = 'private.push_device_registrations'::regclass)
          and not (select bool_or(has_table_privilege(r, 'private.push_device_registrations', p))
                   from unnest(array['public','anon','authenticated','service_role']) r,
                        unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p),
          'RLS still enabled and still no table privilege for client roles');
select ok(not private.push_registration_intake_open() and not private.push_token_change_open(),
          'both gates are still closed after the migration');

-- Fix the time to now() (the transaction start); some tests move it.
create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() $$;

-- ============================================================
-- Fixtures (owner context, dummy values)
-- ============================================================

insert into private.push_device_registrations
  (id, status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, created_at, expires_at)
select ('60000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'active',
       'c2-token-r' || lpad(n::text, 2, '0'), private.push_registration_hash('c2-token-r' || lpad(n::text, 2, '0')),
       private.push_registration_hash(lpad(n::text, 64, '0')), 1, false, true, created, expires
from (values
  (1, now() - interval '240 hours', now() + interval '1440 hours'),   -- token change
  (2, now() - interval '240 hours', now() + interval '5 minutes'),    -- expires before confirming
  (3, now() - interval '240 hours', now() + interval '1440 hours'),   -- direct writes
  (4, now() - interval '1080 hours', now() + interval '1080 hours'),  -- renew (due)
  (5, now() - interval '240 hours', now() + interval '1440 hours'),   -- disable
  (8, now() + interval '1 hour', now() + interval '1440 hours')       -- later than the time used on resume
) v(n, created, expires);

insert into private.push_device_registrations
  (id, status, push_token_hash, confirmed_token_generation, send_paused, notifications_enabled, created_at, expires_at, disabled_at, disabled_reason)
values
  ('60000000-0000-4000-8000-000000000007', 'disabled', private.push_registration_hash('c2-token-r07'), 1, false, true,
   now() - interval '240 hours', now() + interval '1440 hours', now() - interval '24 hours', 'user_disabled');

-- A registration as it was before this migration (sendable_since null):
-- inserted with the insert trigger off, inside this transaction only.
alter table private.push_device_registrations disable trigger push_device_registrations_10_sendable_since;
insert into private.push_device_registrations
  (id, status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, created_at, expires_at)
values
  ('60000000-0000-4000-8000-000000000006', 'active', 'c2-token-r06', private.push_registration_hash('c2-token-r06'),
   private.push_registration_hash(lpad('6', 64, '0')), 1, false, true, now() - interval '240 hours', now() + interval '1440 hours');
alter table private.push_device_registrations enable trigger push_device_registrations_10_sendable_since;

-- ============================================================
-- Insert
-- ============================================================

select is((select sendable_since from private.push_device_registrations where id = '60000000-0000-4000-8000-000000000001'),
          now() - interval '240 hours', 'insert: an active registration gets sendable_since = created_at');
select is((select sendable_since from private.push_device_registrations where id = '60000000-0000-4000-8000-000000000008'),
          now() + interval '1 hour', 'insert: sendable_since follows created_at as given');
select ok((select sendable_since is null from private.push_device_registrations where id = '60000000-0000-4000-8000-000000000007'),
          'insert: a disabled registration gets null');
select lives_ok(
  $$insert into private.push_device_registrations
      (id, status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, created_at, expires_at, sendable_since)
    values ('60000000-0000-4000-8000-000000000009', 'active', 'c2-token-r09', private.push_registration_hash('c2-token-r09'),
      '\xb9', 1, false, true, now(), now() + interval '1440 hours', now())$$,
  'insert: a sendable_since equal to created_at is accepted');
select throws_ok(
  $$insert into private.push_device_registrations
      (id, status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, created_at, expires_at, sendable_since)
    values ('60000000-0000-4000-8000-000000000010', 'active', 'c2-token-r10', private.push_registration_hash('c2-token-r10'),
      '\xba', 1, false, true, now(), now() + interval '1440 hours', now() + interval '1 minute')$$,
  '55000', null, 'insert: any other sendable_since given by the caller is refused');
select throws_ok(
  $$insert into private.push_device_registrations
      (id, status, push_token_hash, confirmed_token_generation, send_paused, notifications_enabled, created_at, expires_at, disabled_at, disabled_reason, sendable_since)
    values ('60000000-0000-4000-8000-000000000011', 'disabled', private.push_registration_hash('c2-token-r11'), 1, false, true,
      now(), now() + interval '1440 hours', now(), 'user_disabled', now())$$,
  '55000', null, 'insert: a disabled registration with a sendable_since is refused');
select ok((select sendable_since is null from private.push_device_registrations where id = '60000000-0000-4000-8000-000000000006')
          and (select tgenabled = 'O' from pg_trigger where tgrelid = 'private.push_device_registrations'::regclass
                 and tgname = 'push_device_registrations_10_sendable_since'),
          'an existing registration keeps null; the insert trigger is enabled again');

-- ============================================================
-- First registration through confirm_push_registration
-- ============================================================

create or replace function private.push_registration_intake_open()
returns boolean language sql stable set search_path = '' as $$ select true $$;

insert into private.push_registration_requests
  (id, purpose, registration_id, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
values
  ('61000000-0000-4000-8000-000000000001', 'new', null, 'c2-token-n1', private.push_registration_hash('c2-token-n1'),
   private.push_registration_hash(repeat('E', 43)), private.push_registration_hash(repeat('F', 43)), 'pending', now() + interval '10 minutes'),
  ('61000000-0000-4000-8000-000000000002', 'new', null, 'c2-token-n2', private.push_registration_hash('c2-token-n2'),
   private.push_registration_hash(repeat('E', 43)), private.push_registration_hash(repeat('F', 43)), 'pending', now() + interval '10 minutes');

create temp table c2_reg on commit drop as
select * from public.confirm_push_registration('61000000-0000-4000-8000-000000000001', repeat('E', 43), repeat('F', 43));

select ok((select c.ok and d.status = 'active' and d.created_at = now() and d.sendable_since = d.created_at
           from c2_reg c join private.push_device_registrations d on d.id = c.registration_id),
          'confirm registration: the new registration gets sendable_since = created_at (the time after the locks)');
select is((select ok from public.confirm_push_registration('61000000-0000-4000-8000-000000000001', repeat('E', 43), repeat('F', 43))), false,
          'confirm registration: a second confirmation is refused');
select is((select count(*)::int from private.push_device_registrations where push_token_hash = private.push_registration_hash('c2-token-n1')), 1,
          'confirm registration: the second confirmation adds no registration');
select is((select ok from public.confirm_push_registration('61000000-0000-4000-8000-000000000002', repeat('E', 43), repeat('X', 43))), false,
          'confirm registration: a wrong nonce is refused');
select is((select count(*)::int from private.push_device_registrations where push_token_hash = private.push_registration_hash('c2-token-n2')), 0,
          'confirm registration: a refused confirmation leaves no registration');

-- ============================================================
-- Token change through the two RPCs
-- ============================================================

create or replace function private.push_token_change_open()
returns boolean language sql stable set search_path = '' as $$ select true $$;

create temp table c2_req_01 on commit drop as
select * from public.create_push_token_change_request('60000000-0000-4000-8000-000000000001', lpad('1', 64, '0'), 'c2-token-r01b', repeat('A', 43), repeat('B', 43));

select ok((select c.ok and c.result = 'created' from c2_req_01 c)
          and (select send_paused and confirmed_token_generation = 1 and sendable_since = now() - interval '240 hours'
               from private.push_device_registrations where id = '60000000-0000-4000-8000-000000000001'),
          'token change request: sending pauses, sendable_since does not move');
select is((select ok from public.confirm_push_token_change((select request_id::text from c2_req_01), lpad('1', 64, '0'), repeat('A', 43), repeat('X', 43))), false,
          'token change confirm: a wrong nonce is refused');
select ok((select send_paused and confirmed_token_generation = 1 and push_token = 'c2-token-r01' and sendable_since = now() - interval '240 hours'
           from private.push_device_registrations where id = '60000000-0000-4000-8000-000000000001'),
          'token change confirm: a refused confirmation changes nothing');

create temp table c2_conf_01 on commit drop as
select * from public.confirm_push_token_change((select request_id::text from c2_req_01), lpad('1', 64, '0'), repeat('A', 43), repeat('B', 43));

select ok((select ok and confirmed_token_generation = 2 and expires_at = now() + interval '1440 hours' from c2_conf_01),
          'token change confirm: confirmed with generation 2, expiry unchanged');
select ok((select not send_paused and confirmed_token_generation = 2 and push_token = 'c2-token-r01b'
             and sendable_since = now() and expires_at = now() + interval '1440 hours' and updated_at = now()
           from private.push_device_registrations where id = '60000000-0000-4000-8000-000000000001'),
          'token change confirm: resume, generation + 1, new token and sendable_since move together; updated_at still set');
select is((select ok from public.confirm_push_token_change((select request_id::text from c2_req_01), lpad('1', 64, '0'), repeat('A', 43), repeat('B', 43))), false,
          'token change confirm: a second confirmation is refused');
select ok((select confirmed_token_generation = 2 and sendable_since = now()
           from private.push_device_registrations where id = '60000000-0000-4000-8000-000000000001'),
          'token change confirm: the second confirmation changes nothing');

-- The registration expires while its token change waits for confirmation.
create temp table c2_req_02 on commit drop as
select * from public.create_push_token_change_request('60000000-0000-4000-8000-000000000002', lpad('2', 64, '0'), 'c2-token-r02b', repeat('A', 43), repeat('B', 43));

create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() + interval '6 minutes' $$;

select is((select ok from public.confirm_push_token_change((select request_id::text from c2_req_02), lpad('2', 64, '0'), repeat('A', 43), repeat('B', 43))), false,
          'token change confirm: refused once the registration has expired');
select ok((select send_paused and confirmed_token_generation = 1 and push_token = 'c2-token-r02' and sendable_since = now() - interval '240 hours'
           from private.push_device_registrations where id = '60000000-0000-4000-8000-000000000002')
          and (select state = 'cancelled' from private.push_registration_requests where id = (select request_id from c2_req_02)),
          'token change confirm: the expired registration stays paused with sendable_since unchanged');

create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() $$;

-- A registration from before the migration (null) gets a value only when a
-- token change is confirmed.
create temp table c2_req_06 on commit drop as
select * from public.create_push_token_change_request('60000000-0000-4000-8000-000000000006', lpad('6', 64, '0'), 'c2-token-r06b', repeat('A', 43), repeat('B', 43));

select ok((select send_paused and sendable_since is null from private.push_device_registrations where id = '60000000-0000-4000-8000-000000000006'),
          'null registration: pausing keeps null');

create temp table c2_conf_06 on commit drop as
select * from public.confirm_push_token_change((select request_id::text from c2_req_06), lpad('6', 64, '0'), repeat('A', 43), repeat('B', 43));

select ok((select c.ok from c2_conf_06 c)
          and (select not send_paused and confirmed_token_generation = 2 and sendable_since = now()
               from private.push_device_registrations where id = '60000000-0000-4000-8000-000000000006'),
          'null registration: a confirmed token change sets sendable_since');

-- ============================================================
-- Direct writes (owner context): the guard
-- ============================================================

select throws_ok(
  $$update private.push_device_registrations set sendable_since = now() + interval '1 hour' where id = '60000000-0000-4000-8000-000000000003'$$,
  '55000', null, 'guard: moving sendable_since forward directly is refused');
select throws_ok(
  $$update private.push_device_registrations set sendable_since = created_at - interval '1 day' where id = '60000000-0000-4000-8000-000000000003'$$,
  '55000', null, 'guard: moving sendable_since back is refused');
select throws_ok(
  $$update private.push_device_registrations set sendable_since = null where id = '60000000-0000-4000-8000-000000000003'$$,
  '55000', null, 'guard: clearing sendable_since is refused');
select lives_ok(
  $$update private.push_device_registrations set sendable_since = sendable_since where id = '60000000-0000-4000-8000-000000000003'$$,
  'guard: setting the same value changes nothing and is accepted');
select lives_ok(
  $$update private.push_device_registrations set send_paused = true, notifications_enabled = false where id = '60000000-0000-4000-8000-000000000003'$$,
  'guard: pausing and other columns are still accepted');
select is((select sendable_since from private.push_device_registrations where id = '60000000-0000-4000-8000-000000000003'),
          now() - interval '240 hours', 'guard: accepted updates leave sendable_since unchanged');
select throws_ok(
  $$update private.push_device_registrations set send_paused = false where id = '60000000-0000-4000-8000-000000000003'$$,
  '55000', null, 'guard (kept): a pause cannot be lifted alone');
select throws_ok(
  $$update private.push_device_registrations set confirmed_token_generation = 2 where id = '60000000-0000-4000-8000-000000000003'$$,
  '55000', null, 'guard (kept): the generation alone cannot go up');
select throws_ok(
  $$update private.push_device_registrations
    set push_token = 'c2-token-r03b', push_token_hash = private.push_registration_hash('c2-token-r03b'),
        confirmed_token_generation = 2, send_paused = false, sendable_since = now() + interval '5 hours'
    where id = '60000000-0000-4000-8000-000000000003'$$,
  '55000', null, 'guard: a confirmation that also gives its own sendable_since is refused');
select ok((select send_paused and confirmed_token_generation = 1 and push_token = 'c2-token-r03' and sendable_since = now() - interval '240 hours'
           from private.push_device_registrations where id = '60000000-0000-4000-8000-000000000003'),
          'guard: refused updates change nothing');
select throws_ok(
  $$update private.push_device_registrations set created_at = created_at + interval '1 hour' where id = '60000000-0000-4000-8000-000000000003'$$,
  '23514', null, 'check: created_at cannot move past sendable_since');

-- Never backwards: a confirmation whose time is before the current value
-- keeps the current value.
select lives_ok(
  $$update private.push_device_registrations set send_paused = true where id = '60000000-0000-4000-8000-000000000008'$$,
  'monotonic: pause');
select lives_ok(
  $$update private.push_device_registrations
    set push_token = 'c2-token-r08b', push_token_hash = private.push_registration_hash('c2-token-r08b'),
        confirmed_token_generation = 2, send_paused = false
    where id = '60000000-0000-4000-8000-000000000008'$$,
  'monotonic: a confirmation (direct, owner) is accepted');
select ok((select not send_paused and confirmed_token_generation = 2 and sendable_since = now() + interval '1 hour'
           from private.push_device_registrations where id = '60000000-0000-4000-8000-000000000008'),
          'monotonic: sendable_since stays at its later value instead of going back to the confirmation time');

-- ============================================================
-- Other RPCs leave sendable_since alone
-- ============================================================

select ok((select ok and result = 'renewed' and expires_at = now() + interval '2160 hours'
           from public.renew_push_registration('60000000-0000-4000-8000-000000000004', lpad('4', 64, '0'), 'c2-token-r04', '1', true, true)),
          'renew: still renewed at exactly 45 x 24 hours left, for 90 x 24 hours');
select is((select sendable_since from private.push_device_registrations where id = '60000000-0000-4000-8000-000000000004'),
          now() - interval '1080 hours', 'renew: sendable_since unchanged');
select ok((select ok and result = 'disabled' from public.disable_push_registration('60000000-0000-4000-8000-000000000005', lpad('5', 64, '0'))),
          'disable: still disables');
select ok((select status = 'disabled' and sendable_since = now() - interval '240 hours'
           from private.push_device_registrations where id = '60000000-0000-4000-8000-000000000005'),
          'disable: sendable_since unchanged');
select throws_ok(
  $$update private.push_device_registrations
    set status = 'active', disabled_at = null, disabled_reason = null, push_token = 'c2-token-r05', secret_hash = '\xb5'
    where id = '60000000-0000-4000-8000-000000000005'$$,
  '55000', null, 'guard (kept): a disabled registration cannot be reactivated');

-- ============================================================
-- Nothing else moved
-- ============================================================

select ok((select bool_and(sendable_since is null or sendable_since >= created_at) from private.push_device_registrations),
          'every row: sendable_since is null or not before created_at');
select is((select count(*)::int from private.push_device_registrations where status = 'active' and sendable_since is null), 0,
          'every active row touched here has a sendable_since (the null one got it from its token change)');

select * from finish();
rollback;
