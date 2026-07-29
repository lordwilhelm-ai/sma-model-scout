-- organizer-login.html/contestant-login.html sign up via supabase.auth.signUp(),
-- then immediately insert a profile row into organizers/contestants using the
-- browser's own (anon-key) session. That insert is rejected by RLS whenever
-- there's no active session yet at that exact moment — which happens whenever
-- "Confirm email" is enabled on this project, since signUp() doesn't return a
-- session until the user clicks the confirmation link.
--
-- Fix: create the profile row server-side, in a trigger on auth.users, using
-- metadata passed via signUp's `options.data`. This runs synchronously as part
-- of the same insert as the auth user itself (security definer bypasses RLS),
-- so it works immediately regardless of the confirm-email setting.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.raw_user_meta_data->>'role' = 'organizer' then
    insert into public.organizers (id, full_name, phone, email, brand, status)
    values (
      new.id,
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'phone',
      new.email,
      new.raw_user_meta_data->>'brand',
      'active'
    )
    on conflict (id) do nothing;

  elsif new.raw_user_meta_data->>'role' = 'contestant' then
    insert into public.contestants (id, full_name, phone, email, event_name, contestant_number)
    values (
      new.id,
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'phone',
      new.email,
      new.raw_user_meta_data->>'event_name',
      new.raw_user_meta_data->>'contestant_number'
    )
    on conflict (id) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
