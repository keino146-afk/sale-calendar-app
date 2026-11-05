-- When a device registration became sendable (roadmap 3, C2).
--
-- private.push_device_registrations gets sendable_since: the time from which
-- the registration may be sent to, kept by triggers only, so the two
-- confirmation RPCs (public.confirm_push_registration and
-- public.confirm_push_token_change) are not changed at all.
--
--   - A registration inserted active gets sendable_since = created_at, the
--     time confirm_push_registration took once its locks were held; one
--     inserted disabled gets null. A value given by the caller is refused
--     (55000) unless it is exactly what would be set.
--   - It moves only when the transition guard sees a token change confirmed
--     (active to active, paused to resumed, generation + 1, the same check
--     that already allows those changes): then it becomes the greater of its
--     old value, created_at and private.push_registration_current_time(),
--     in the same row update that resumes sending and raises the generation.
--     Any other change to it is refused (55000), so it never goes back.
--     Setting it to the value it already has changes nothing and cannot be
--     told apart from not setting it.
--   - Existing rows keep null (not sendable): no past pause can be inferred,
--     so nothing is filled in.
--   - sendable_since is null or not before created_at (check constraint).
--
-- Nothing sends yet: the future sending path is to treat null as "do not
-- send" and to skip notifications due before this time. The registration
-- and token change gates stay closed (select false), no RPC, grant, policy
-- or P6 object changes, and every check of the transition guard is kept.
--
-- Everything runs in one DO statement, so it is applied entirely or not at
-- all whether or not the migration runner wraps the file in a transaction.

do $migration$
begin
  execute $ddl$
    alter table private.push_device_registrations
      add column sendable_since timestamptz null
  $ddl$;

  execute $ddl$
    alter table private.push_device_registrations
      add constraint push_device_registrations_sendable_since_after_created
      check (sendable_since is null or sendable_since >= created_at)
  $ddl$;

  -- Insert: set from created_at (active) or null (disabled).
  execute $ddl$
    create function private.set_push_registration_sendable_since()
    returns trigger
    language plpgsql
    set search_path = ''
    as $fn$
    begin
      if new.sendable_since is not null
        and (new.status is distinct from 'active' or new.sendable_since is distinct from new.created_at) then
        raise exception 'sendable_since is set from created_at when a registration is inserted'
          using errcode = '55000';
      end if;

      new.sendable_since := case when new.status = 'active' then new.created_at else null end;
      return new;
    end;
    $fn$
  $ddl$;

  execute $ddl$
    create trigger push_device_registrations_10_sendable_since
      before insert on private.push_device_registrations
      for each row execute function private.set_push_registration_sendable_since()
  $ddl$;

  -- Update: the guard of 20261101125026 with every check kept, plus
  -- sendable_since.
  execute $ddl$
    create or replace function private.enforce_push_device_registration_transition()
    returns trigger
    language plpgsql
    set search_path = ''
    as $fn$
    declare
      v_confirmation boolean;
    begin
      if old.status = 'disabled' and new.status = 'active' then
        raise exception 'disabled push device registrations cannot be reactivated'
          using errcode = '55000';
      end if;

      if new.confirmed_token_generation <> old.confirmed_token_generation
        and new.confirmed_token_generation::bigint <> old.confirmed_token_generation::bigint + 1 then
        raise exception 'confirmed token generation may only stay the same or increase by one'
          using errcode = '55000';
      end if;

      v_confirmation := old.status = 'active' and new.status = 'active'
        and old.send_paused and not new.send_paused
        and new.confirmed_token_generation::bigint = old.confirmed_token_generation::bigint + 1;

      if new.confirmed_token_generation <> old.confirmed_token_generation and not v_confirmation then
        raise exception 'confirmed token generation changes only when a paused registration resumes'
          using errcode = '55000';
      end if;

      if old.send_paused and not new.send_paused and not v_confirmation then
        raise exception 'a paused registration resumes only with a new confirmed token generation'
          using errcode = '55000';
      end if;

      if old.status = 'active' and new.status = 'active'
        and (new.push_token is distinct from old.push_token
          or new.push_token_hash is distinct from old.push_token_hash)
        and not v_confirmation then
        raise exception 'the token of an active registration changes only with a new confirmed token generation'
          using errcode = '55000';
      end if;

      -- sendable_since is never written directly; it only moves forward,
      -- below, with a confirmed token change.
      if new.sendable_since is distinct from old.sendable_since then
        raise exception 'sendable_since changes only with a confirmed token change'
          using errcode = '55000';
      end if;

      if v_confirmation then
        new.sendable_since := greatest(
          coalesce(old.sendable_since, '-infinity'::timestamptz),
          new.created_at,
          private.push_registration_current_time());
      end if;

      return new;
    end;
    $fn$
  $ddl$;

  execute $ddl$
    revoke all on function private.set_push_registration_sendable_since()
      from public, anon, authenticated, service_role
  $ddl$;

  execute $ddl$
    revoke all on function private.enforce_push_device_registration_transition()
      from public, anon, authenticated, service_role
  $ddl$;
end;
$migration$;
