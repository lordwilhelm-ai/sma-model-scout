-- sma-model-scout: Row Level Security policies
-- Run after schema.sql. Assumes anon/authenticated roles are Supabase's defaults.

-- =========================================================
-- events / event_categories / event_contestants / event_ticket_types
-- Public read (voting UI, leaderboards). Writes: owning organizer or admin.
-- =========================================================

alter table events enable row level security;
alter table event_categories enable row level security;
alter table event_contestants enable row level security;
alter table event_ticket_types enable row level security;

create policy "events_public_read" on events
  for select using (true);

create policy "events_organizer_write" on events
  for all using (organizer_id = auth.uid() or is_admin(auth.uid()))
  with check (organizer_id = auth.uid() or is_admin(auth.uid()));

create policy "event_categories_public_read" on event_categories
  for select using (true);

create policy "event_categories_organizer_write" on event_categories
  for all using (organizer_id = auth.uid() or is_admin(auth.uid()))
  with check (organizer_id = auth.uid() or is_admin(auth.uid()));

create policy "event_contestants_public_read" on event_contestants
  for select using (true);

create policy "event_contestants_organizer_write" on event_contestants
  for all using (organizer_id = auth.uid() or is_admin(auth.uid()))
  with check (organizer_id = auth.uid() or is_admin(auth.uid()));

create policy "event_ticket_types_public_read" on event_ticket_types
  for select using (true);

create policy "event_ticket_types_organizer_write" on event_ticket_types
  for all using (organizer_id = auth.uid() or is_admin(auth.uid()))
  with check (organizer_id = auth.uid() or is_admin(auth.uid()));

-- =========================================================
-- organizers / contestants — own row only, or admin
-- =========================================================

alter table organizers enable row level security;
alter table contestants enable row level security;

create policy "organizers_self_or_admin" on organizers
  for all using (id = auth.uid() or is_admin(auth.uid()))
  with check (id = auth.uid() or is_admin(auth.uid()));

create policy "contestants_self_or_admin" on contestants
  for all using (id = auth.uid() or is_admin(auth.uid()))
  with check (id = auth.uid() or is_admin(auth.uid()));

-- =========================================================
-- admin_users — no client policies; only readable via is_admin() (security definer)
-- =========================================================

alter table admin_users enable row level security;
-- deliberately no policies: RLS enabled + zero policies = deny-all for anon/authenticated.

-- =========================================================
-- applications — public insert (unauthenticated form), admin-only read
-- =========================================================

alter table applications enable row level security;

create policy "applications_public_insert" on applications
  for insert with check (true);

create policy "applications_admin_read" on applications
  for select using (is_admin(auth.uid()));

create policy "applications_admin_write" on applications
  for update using (is_admin(auth.uid()))
  with check (is_admin(auth.uid()));

-- =========================================================
-- platform_settings — public read, admin-only write
-- =========================================================

alter table platform_settings enable row level security;

create policy "platform_settings_public_read" on platform_settings
  for select using (true);

create policy "platform_settings_admin_write" on platform_settings
  for update using (is_admin(auth.uid()))
  with check (is_admin(auth.uid()));

-- =========================================================
-- pending_transactions / payment_transactions — service-role only.
-- No policies for anon/authenticated: RLS enabled + zero policies = deny-all,
-- but the service-role key used by Vercel functions bypasses RLS entirely.
-- Add a narrow admin read policy for payment_transactions since admin.html
-- reports on payment history.
-- =========================================================

alter table pending_transactions enable row level security;
alter table payment_transactions enable row level security;

create policy "payment_transactions_admin_read" on payment_transactions
  for select using (is_admin(auth.uid()));

create policy "payment_transactions_organizer_read" on payment_transactions
  for select using (
    event_id in (select id from events where organizer_id = auth.uid())
  );
