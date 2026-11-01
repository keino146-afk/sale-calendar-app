-- pgTAP tests for the push device registration tables (roadmap 3, U1-A).
-- Everything runs inside one transaction and is rolled back. Tokens,
-- hashes and secrets below are dummy values. One transaction cannot test
-- real concurrency; that is left to a later, separate check.

begin;

create extension if not exists pgtap with schema extensions;

select plan(90);

-- ============================================================
-- Structure, grants and RLS (state right after the migration)
-- ============================================================

select has_table('private', 'push_device_registrations', 'private.push_device_registrations exists');
select has_table('private', 'push_registration_requests', 'private.push_registration_requests exists');
select ok((select relrowsecurity from pg_class where oid = 'private.push_device_registrations'::regclass), 'RLS enabled on push_device_registrations');
select ok((select relrowsecurity from pg_class where oid = 'private.push_registration_requests'::regclass), 'RLS enabled on push_registration_requests');
select is((select count(*)::int from pg_policies where schemaname = 'private' and tablename in ('push_device_registrations', 'push_registration_requests')), 0, 'no policies on the registration tables');
select ok(not (select bool_or(has_table_privilege(r, t, p)) from unnest(array['public','anon','authenticated','service_role']) r, unnest(array['private.push_device_registrations','private.push_registration_requests']) t, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p), 'no table privilege for public, anon, authenticated or service_role');
select ok(not (select bool_or(has_function_privilege(r, f, 'execute')) from unnest(array['public','anon','authenticated','service_role']) r, unnest(array['private.enforce_push_device_registration_transition()','private.enforce_push_registration_request_transition()']) f), 'transition guards are not executable by client roles');
select ok((select bool_and(not prosecdef and proconfig @> array['search_path=""']) from pg_proc where oid in ('private.enforce_push_device_registration_transition()'::regprocedure, 'private.enforce_push_registration_request_transition()'::regprocedure)), 'transition guards are SECURITY INVOKER with empty search_path');
select is((select count(*)::int from pg_proc where strpos(prosrc, 'push_device_registrations') > 0 or strpos(prosrc, 'push_registration_requests') > 0), 0, 'no function reads or writes the registration tables (no RPC in U1-A)');

select is(
  (select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position)
   from information_schema.columns where table_schema = 'private' and table_name = 'push_device_registrations'),
  'id:uuid:NO,status:text:NO,push_token:text:YES,push_token_hash:bytea:YES,secret_hash:bytea:YES,confirmed_token_generation:integer:NO,send_paused:boolean:NO,notifications_enabled:boolean:NO,expires_at:timestamp with time zone:NO,created_at:timestamp with time zone:NO,updated_at:timestamp with time zone:NO,disabled_at:timestamp with time zone:YES,disabled_reason:text:YES',
  'push_device_registrations columns, types and nullability'
);
select is(
  (select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position)
   from information_schema.columns where table_schema = 'private' and table_name = 'push_registration_requests'),
  'id:uuid:NO,purpose:text:NO,registration_id:uuid:YES,push_token:text:YES,push_token_hash:bytea:NO,request_secret_hash:bytea:YES,nonce_hash:bytea:YES,state:text:NO,expires_at:timestamp with time zone:NO,failed_attempts:integer:NO,closed_at:timestamp with time zone:YES,created_at:timestamp with time zone:NO',
  'push_registration_requests columns, types and nullability'
);
select col_is_pk('private', 'push_device_registrations', 'id', 'push_device_registrations.id is the primary key');
select col_is_pk('private', 'push_registration_requests', 'id', 'push_registration_requests.id is the primary key');
select is((select confdeltype::text || ':' || confrelid::regclass::text from pg_constraint where conrelid = 'private.push_registration_requests'::regclass and contype = 'f'), 'r:private.push_device_registrations', 'registration_id references push_device_registrations ON DELETE RESTRICT');
select col_default_is('private', 'push_registration_requests', 'failed_attempts', '0', 'failed_attempts defaults to 0');
select col_hasnt_default('private', 'push_device_registrations', 'send_paused', 'send_paused has no default');
select col_hasnt_default('private', 'push_device_registrations', 'notifications_enabled', 'notifications_enabled has no default');

-- ============================================================
-- Fixtures (owner context, dummy values)
-- ============================================================

insert into private.push_device_registrations
  (id, status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at)
values
  ('30000000-0000-4000-8000-000000000001', 'active', 'test-token-a', '\xa1', '\xb1', 1, false, true, now() + interval '2160 hours'),
  ('30000000-0000-4000-8000-000000000002', 'active', 'test-token-b', '\xa2', '\xb2', 1, false, true, now() + interval '2160 hours');

-- ============================================================
-- push_device_registrations: columns and states
-- ============================================================

select throws_ok(
  $$insert into private.push_device_registrations (status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at)
    values ('expired', 'test-token-x', '\xa9', '\xb9', 1, false, true, now() + interval '1 hour')$$,
  '23514', null, 'unknown status is rejected'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at)
    values ('active', 'test-token-x', '\xa9', '\xb9', 0, false, true, now() + interval '1 hour')$$,
  '23514', null, 'token generation 0 is rejected'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at)
    values ('active', null, '\xa9', '\xb9', 1, false, true, now() + interval '1 hour')$$,
  '23514', null, 'active registration without token is rejected'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at)
    values ('active', 'test-token-x', null, '\xb9', 1, false, true, now() + interval '1 hour')$$,
  '23514', null, 'active registration without token hash is rejected'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at)
    values ('active', 'test-token-x', '\xa9', null, 1, false, true, now() + interval '1 hour')$$,
  '23514', null, 'active registration without secret hash is rejected'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at)
    values ('active', 'test-token-x', '\xa9', '\xb9', 1, null, true, now() + interval '1 hour')$$,
  '23502', null, 'send_paused must be given'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at)
    values ('active', 'test-token-x', '\xa9', '\xb9', 1, false, null, now() + interval '1 hour')$$,
  '23502', null, 'notifications_enabled must be given'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, created_at, expires_at)
    values ('active', 'test-token-x', '\xa9', '\xb9', 1, false, true, '2026-11-01 00:00+00', '2026-11-01 00:00+00')$$,
  '23514', null, 'expires_at not after created_at is rejected'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at)
    values ('active', repeat('a', 1025), '\xa9', '\xb9', 1, false, true, now() + interval '1 hour')$$,
  '23514', null, 'token of 1025 bytes is rejected'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at)
    values ('active', repeat('あ', 342), '\xa9', '\xb9', 1, false, true, now() + interval '1 hour')$$,
  '23514', null, 'token limit is in bytes: 342 three-byte characters (1026 bytes) are rejected'
);
select lives_ok(
  $$insert into private.push_device_registrations (status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at)
    values ('active', repeat('a', 1024), '\xa3', '\xb3', 1, false, true, now() + interval '1 hour')$$,
  'token of exactly 1024 bytes is accepted'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at)
    values ('active', 'test-token-x', ''::bytea, '\xb9', 1, false, true, now() + interval '1 hour')$$,
  '23514', null, 'empty token hash is rejected'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at)
    values ('active', 'test-token-x', '\xa9', decode(repeat('ab', 65), 'hex'), 1, false, true, now() + interval '1 hour')$$,
  '23514', null, 'secret hash of 65 bytes is rejected'
);
select lives_ok(
  $$insert into private.push_device_registrations (status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at)
    values ('active', 'test-token-c', decode(repeat('ac', 64), 'hex'), decode(repeat('bc', 64), 'hex'), 1, false, true, now() + interval '1 hour')$$,
  'hashes of exactly 64 bytes are accepted'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at, disabled_at)
    values ('active', 'test-token-x', '\xa9', '\xb9', 1, false, true, now() + interval '1 hour', now())$$,
  '23514', null, 'active registration with disabled_at is rejected'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at, disabled_at)
    values ('disabled', '\xa9', 1, false, true, now() + interval '1 hour', now())$$,
  '23514', null, 'disabled registration without disabled_reason is rejected'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at, disabled_reason)
    values ('disabled', '\xa9', 1, false, true, now() + interval '1 hour', 'user_disabled')$$,
  '23514', null, 'disabled registration without disabled_at is rejected'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token, push_token_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at, disabled_at, disabled_reason)
    values ('disabled', 'test-token-x', '\xa9', 1, false, true, now() + interval '1 hour', now(), 'user_disabled')$$,
  '23514', null, 'disabled registration keeping the token is rejected'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at, disabled_at, disabled_reason)
    values ('disabled', '\xa9', '\xb9', 1, false, true, now() + interval '1 hour', now(), 'user_disabled')$$,
  '23514', null, 'disabled registration keeping the secret hash is rejected'
);
select lives_ok(
  $$insert into private.push_device_registrations (status, push_token_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at, disabled_at, disabled_reason)
    values ('disabled', '\xa1', 1, false, true, now() + interval '1 hour', now(), 'user_disabled')$$,
  'disabled registration may keep the token hash, also one an active registration uses'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at, disabled_at, disabled_reason)
    values ('disabled', '\xa9', 1, false, true, now() + interval '1 hour', now(), 'User_disabled')$$,
  '23514', null, 'disabled_reason with an upper-case letter is rejected'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at, disabled_at, disabled_reason)
    values ('disabled', '\xa9', 1, false, true, now() + interval '1 hour', now(), 'token[x]')$$,
  '23514', null, 'disabled_reason with brackets is rejected'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at, disabled_at, disabled_reason)
    values ('disabled', '\xa9', 1, false, true, now() + interval '1 hour', now(), '')$$,
  '23514', null, 'empty disabled_reason is rejected'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at, disabled_at, disabled_reason)
    values ('disabled', '\xa9', 1, false, true, now() + interval '1 hour', now(), repeat('a', 65))$$,
  '23514', null, 'disabled_reason of 65 characters is rejected'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at, disabled_at, disabled_reason)
    values ('disabled', '\xa9', 1, false, true, now() + interval '1 hour', now(), E'user_disabled\n')$$,
  '23514', null, 'disabled_reason with a trailing newline is rejected'
);
select lives_ok(
  $$insert into private.push_device_registrations (status, push_token_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at, disabled_at, disabled_reason)
    values ('disabled', '\xa9', 1, false, true, now() + interval '1 hour', now(), 'a' || repeat('b', 63))$$,
  'disabled_reason of 64 characters is accepted'
);
select throws_ok(
  $$insert into private.push_device_registrations (status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at)
    values ('active', 'test-token-a2', '\xa1', '\xb9', 1, false, true, now() + interval '1 hour')$$,
  '23505', null, 'two active registrations with the same token hash are rejected'
);

-- ============================================================
-- push_device_registrations: transitions
-- ============================================================

select lives_ok(
  $$update private.push_device_registrations set confirmed_token_generation = 2
    where id = '30000000-0000-4000-8000-000000000002'$$,
  'token generation may go up by one'
);
select throws_ok(
  $$update private.push_device_registrations set confirmed_token_generation = 4
    where id = '30000000-0000-4000-8000-000000000002'$$,
  '55000', null, 'token generation may not jump by more than one'
);
select throws_ok(
  $$update private.push_device_registrations set confirmed_token_generation = 1
    where id = '30000000-0000-4000-8000-000000000002'$$,
  '55000', null, 'token generation may not go down'
);
select lives_ok(
  $$update private.push_device_registrations set notifications_enabled = false
    where id = '30000000-0000-4000-8000-000000000002'$$,
  'other columns may change with the generation unchanged'
);
select lives_ok(
  $$update private.push_device_registrations set send_paused = true
    where id = '30000000-0000-4000-8000-000000000002'$$,
  'an active registration may be paused (B3)'
);
select throws_ok(
  $$update private.push_device_registrations
    set status = 'disabled', disabled_at = now(), disabled_reason = 'user_disabled'
    where id = '30000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'disabling without removing the token and the secret hash is rejected'
);
select lives_ok(
  $$update private.push_device_registrations
    set status = 'disabled', disabled_at = now(), disabled_reason = 'token_replaced', push_token = null, secret_hash = null
    where id = '30000000-0000-4000-8000-000000000002'$$,
  'disabling with the token and the secret hash removed is accepted'
);
select throws_ok(
  $$update private.push_device_registrations
    set status = 'active', disabled_at = null, disabled_reason = null, push_token = 'test-token-b', secret_hash = '\xb2'
    where id = '30000000-0000-4000-8000-000000000002'$$,
  '55000', null, 'a disabled registration cannot be reactivated'
);
select is(
  (select status || ':' || confirmed_token_generation::text from private.push_device_registrations where id = '30000000-0000-4000-8000-000000000002'),
  'disabled:2', 'the disabled registration stays disabled at generation 2'
);

-- ============================================================
-- push_registration_requests: columns and states
-- ============================================================

insert into private.push_registration_requests
  (id, purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
values
  ('31000000-0000-4000-8000-000000000001', 'new', 'test-token-c1', '\xc1', '\xd1', '\xe1', 'pending', now() + interval '10 minutes');

select throws_ok(
  $$insert into private.push_registration_requests (purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
    values ('renew', 'test-token-x', '\xc9', '\xd9', '\xe9', 'pending', now() + interval '10 minutes')$$,
  '23514', null, 'unknown purpose is rejected'
);
select throws_ok(
  $$insert into private.push_registration_requests (purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
    values ('new', 'test-token-x', '\xc9', '\xd9', '\xe9', 'failed', now() + interval '10 minutes')$$,
  '23514', null, 'unknown state is rejected'
);
select throws_ok(
  $$insert into private.push_registration_requests (purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
    values ('token_change', 'test-token-x', '\xc9', '\xd9', '\xe9', 'pending', now() + interval '10 minutes')$$,
  '23514', null, 'token_change without registration_id is rejected'
);
select throws_ok(
  $$insert into private.push_registration_requests (purpose, registration_id, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
    values ('new', '30000000-0000-4000-8000-000000000001', 'test-token-x', '\xc9', '\xd9', '\xe9', 'pending', now() + interval '10 minutes')$$,
  '23514', null, 'new request with registration_id is rejected'
);
select throws_ok(
  $$insert into private.push_registration_requests (purpose, registration_id, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
    values ('token_change', '30000000-0000-4000-8000-0000000000ff', 'test-token-x', '\xc9', '\xd9', '\xe9', 'pending', now() + interval '10 minutes')$$,
  '23503', null, 'registration_id must reference an existing registration'
);
select throws_ok(
  $$insert into private.push_registration_requests (purpose, push_token, push_token_hash, nonce_hash, state, expires_at)
    values ('new', 'test-token-x', '\xc9', '\xe9', 'pending', now() + interval '10 minutes')$$,
  '23514', null, 'pending request without request secret hash is rejected'
);
select throws_ok(
  $$insert into private.push_registration_requests (purpose, push_token, push_token_hash, request_secret_hash, state, expires_at)
    values ('new', 'test-token-x', '\xc9', '\xd9', 'pending', now() + interval '10 minutes')$$,
  '23514', null, 'pending request without nonce hash is rejected'
);
select throws_ok(
  $$insert into private.push_registration_requests (purpose, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
    values ('new', '\xc9', '\xd9', '\xe9', 'pending', now() + interval '10 minutes')$$,
  '23514', null, 'pending request without token is rejected'
);
select throws_ok(
  $$insert into private.push_registration_requests (purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at, closed_at)
    values ('new', 'test-token-x', '\xc9', '\xd9', '\xe9', 'pending', now() + interval '10 minutes', now())$$,
  '23514', null, 'pending request with closed_at is rejected'
);
select throws_ok(
  $$insert into private.push_registration_requests (purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at, failed_attempts)
    values ('new', 'test-token-x', '\xc9', '\xd9', '\xe9', 'pending', now() + interval '10 minutes', -1)$$,
  '23514', null, 'negative failed_attempts is rejected'
);
select throws_ok(
  $$insert into private.push_registration_requests (purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, created_at, expires_at)
    values ('new', 'test-token-x', '\xc9', '\xd9', '\xe9', 'pending', '2026-11-01 00:00+00', '2026-11-01 00:00+00')$$,
  '23514', null, 'expires_at not after created_at is rejected'
);
select throws_ok(
  $$insert into private.push_registration_requests (purpose, push_token, request_secret_hash, nonce_hash, state, expires_at)
    values ('new', 'test-token-x', '\xd9', '\xe9', 'pending', now() + interval '10 minutes')$$,
  '23502', null, 'token hash is required'
);
select throws_ok(
  $$insert into private.push_registration_requests (purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
    values ('new', 'test-token-x', '\xc9', decode(repeat('ab', 65), 'hex'), '\xe9', 'pending', now() + interval '10 minutes')$$,
  '23514', null, 'request secret hash of 65 bytes is rejected'
);
select throws_ok(
  $$insert into private.push_registration_requests (purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
    values ('new', 'test-token-c1b', '\xc1', '\xd9', '\xe9', 'pending', now() + interval '10 minutes')$$,
  '23505', null, 'two pending requests for the same token hash are rejected'
);
select lives_ok(
  $$insert into private.push_registration_requests (id, purpose, registration_id, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
    values ('31000000-0000-4000-8000-000000000002', 'token_change', '30000000-0000-4000-8000-000000000001', 'test-token-c2', '\xc2', '\xd2', '\xe2', 'pending', now() + interval '10 minutes')$$,
  'a pending token_change request for an existing registration is accepted'
);
select throws_ok(
  $$insert into private.push_registration_requests (purpose, registration_id, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
    values ('token_change', '30000000-0000-4000-8000-000000000001', 'test-token-c3', '\xc3', '\xd3', '\xe3', 'pending', now() + interval '10 minutes')$$,
  '23505', null, 'two pending token_change requests for the same registration are rejected'
);

-- ============================================================
-- push_registration_requests: closing and transitions
-- ============================================================

select throws_ok(
  $$update private.push_registration_requests set state = 'consumed', closed_at = now()
    where id = '31000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'closing without removing the token, request secret hash and nonce hash is rejected'
);
select throws_ok(
  $$update private.push_registration_requests set state = 'expired', push_token = null, request_secret_hash = null, nonce_hash = null
    where id = '31000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'closing without closed_at is rejected'
);
select lives_ok(
  $$update private.push_registration_requests
    set state = 'consumed', closed_at = now(), push_token = null, request_secret_hash = null, nonce_hash = null
    where id = '31000000-0000-4000-8000-000000000001'$$,
  'pending -> consumed with the secrets removed is accepted'
);
select is(
  (select (push_token is null and request_secret_hash is null and nonce_hash is null and push_token_hash = '\xc1')::text
   from private.push_registration_requests where id = '31000000-0000-4000-8000-000000000001'),
  'true', 'a closed request keeps only the token hash'
);
select lives_ok(
  $$insert into private.push_registration_requests (id, purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
    values ('31000000-0000-4000-8000-000000000003', 'new', 'test-token-c1', '\xc1', '\xd4', '\xe4', 'pending', now() + interval '10 minutes')$$,
  'after consumed, a new pending request for the same token is accepted'
);
select lives_ok(
  $$update private.push_registration_requests
    set state = 'expired', closed_at = now(), push_token = null, request_secret_hash = null, nonce_hash = null
    where id = '31000000-0000-4000-8000-000000000003'$$,
  'pending -> expired is accepted'
);
select lives_ok(
  $$insert into private.push_registration_requests (id, purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
    values ('31000000-0000-4000-8000-000000000004', 'new', 'test-token-c1', '\xc1', '\xd5', '\xe5', 'pending', now() + interval '10 minutes')$$,
  'after expired, a new pending request for the same token is accepted'
);
select lives_ok(
  $$update private.push_registration_requests
    set state = 'cancelled', closed_at = now(), push_token = null, request_secret_hash = null, nonce_hash = null
    where id = '31000000-0000-4000-8000-000000000004'$$,
  'pending -> cancelled is accepted'
);
select lives_ok(
  $$insert into private.push_registration_requests (id, purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
    values ('31000000-0000-4000-8000-000000000005', 'new', 'test-token-c1', '\xc1', '\xd6', '\xe6', 'pending', now() + interval '10 minutes')$$,
  'after cancelled, a new pending request for the same token is accepted'
);
select lives_ok(
  $$update private.push_registration_requests set failed_attempts = failed_attempts + 1
    where id = '31000000-0000-4000-8000-000000000005'$$,
  'a pending request may count a failed attempt'
);
select throws_ok(
  $$update private.push_registration_requests
    set state = 'pending', closed_at = null, push_token = 'test-token-c1', request_secret_hash = '\xd1', nonce_hash = '\xe1'
    where id = '31000000-0000-4000-8000-000000000001'$$,
  '55000', null, 'a consumed request cannot return to pending'
);
select throws_ok(
  $$update private.push_registration_requests set state = 'cancelled'
    where id = '31000000-0000-4000-8000-000000000001'$$,
  '55000', null, 'a consumed request cannot change to another closed state'
);
select throws_ok(
  $$update private.push_registration_requests
    set state = 'pending', closed_at = null, push_token = 'test-token-c1', request_secret_hash = '\xd4', nonce_hash = '\xe4'
    where id = '31000000-0000-4000-8000-000000000003'$$,
  '55000', null, 'an expired request cannot return to pending'
);
select throws_ok(
  $$update private.push_registration_requests
    set state = 'pending', closed_at = null, push_token = 'test-token-c1', request_secret_hash = '\xd5', nonce_hash = '\xe5'
    where id = '31000000-0000-4000-8000-000000000004'$$,
  '55000', null, 'a cancelled request cannot return to pending'
);

-- ============================================================
-- Deleting a referenced registration (ON DELETE RESTRICT)
-- ============================================================

select throws_ok(
  $$delete from private.push_device_registrations where id = '30000000-0000-4000-8000-000000000001'$$,
  '23503', null, 'a registration referenced by a pending request cannot be deleted'
);
select lives_ok(
  $$update private.push_registration_requests
    set state = 'cancelled', closed_at = now(), push_token = null, request_secret_hash = null, nonce_hash = null
    where id = '31000000-0000-4000-8000-000000000002'$$,
  'the token_change request can be cancelled'
);
select throws_ok(
  $$delete from private.push_device_registrations where id = '30000000-0000-4000-8000-000000000001'$$,
  '23503', null, 'a registration referenced by a closed request still cannot be deleted'
);

-- ============================================================
-- Client roles cannot reach the tables at all
-- ============================================================

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;

select throws_ok(
  $$select count(*) from private.push_device_registrations$$,
  '42501', null, 'anon cannot read push_device_registrations'
);
select throws_ok(
  $$insert into private.push_registration_requests (purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
    values ('new', 'test-token-x', '\xc9', '\xd9', '\xe9', 'pending', now() + interval '10 minutes')$$,
  '42501', null, 'anon cannot insert push_registration_requests'
);

reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000d0b01","role":"authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$select count(*) from private.push_registration_requests$$,
  '42501', null, 'authenticated cannot read push_registration_requests'
);
select throws_ok(
  $$update private.push_device_registrations set notifications_enabled = true$$,
  '42501', null, 'authenticated cannot update push_device_registrations'
);

reset role;

select * from finish();

rollback;
