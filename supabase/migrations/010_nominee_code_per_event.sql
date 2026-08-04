-- Reverts 009's global uniqueness: 3 digits shared across the WHOLE
-- platform forever (1000 codes total) doesn't scale. Instead, nominee_code
-- goes back to unique-per-event, same as before 009, but the ambiguity
-- 009 was actually trying to prevent is now solved a different way —
-- api/ussd-menu.js asks for the Event Code before the Contestant Code
-- (exactly like the ticket flow already does), so the lookup is always
-- scoped to one event and can never be ambiguous, regardless of how many
-- other events reuse the same 3-digit code. Each event gets its own full
-- 1000-code space instead of sharing one platform-wide pool.
--
-- Written defensively (drop-if-exists / add-if-missing) so it's safe to
-- run whether or not 009 was ever actually applied.

do $$
declare
  v_constraint_name text;
begin
  select conname into v_constraint_name
    from pg_constraint
    where conrelid = 'event_contestants'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (nominee_code)';

  if v_constraint_name is not null then
    execute format('alter table event_contestants drop constraint %I', v_constraint_name);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'event_contestants'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (event_id, nominee_code)'
  ) then
    alter table event_contestants
      add constraint event_contestants_event_id_nominee_code_key unique (event_id, nominee_code);
  end if;
end $$;

-- The 3-digit format check from 009 is unaffected and stays as-is.
