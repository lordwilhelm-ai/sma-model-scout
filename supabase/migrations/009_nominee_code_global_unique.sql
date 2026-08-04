-- nominee_code was only unique per-event (unique(event_id, nominee_code)),
-- so the same 3-digit code could legitimately exist in two different
-- events running at once. api/ussd-menu.js already handles that case
-- gracefully with a "which event?" menu, but the real fix is to stop it
-- happening at all: make nominee_code globally unique, same as event_code
-- already is. Also enforce the 3-digit format organizers are now asked to
-- use everywhere it's entered.
--
-- No existing event_contestants row currently has a nominee_code set (the
-- "Add Contestant" UI never had a field for it until now), so this is safe
-- to apply immediately with no backfill or data cleanup needed. If that's
-- no longer true by the time this runs, the ADD CONSTRAINT UNIQUE step
-- below will fail loudly rather than silently corrupting anything — resolve
-- any duplicate nominee_code values first if so.

do $$
declare
  v_constraint_name text;
begin
  select conname into v_constraint_name
    from pg_constraint
    where conrelid = 'event_contestants'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (event_id, nominee_code)';

  if v_constraint_name is not null then
    execute format('alter table event_contestants drop constraint %I', v_constraint_name);
  end if;
end $$;

alter table event_contestants
  add constraint event_contestants_nominee_code_key unique (nominee_code);

alter table event_contestants
  add constraint event_contestants_nominee_code_format
  check (nominee_code is null or nominee_code ~ '^[0-9]{3}$');
