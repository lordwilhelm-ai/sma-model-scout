-- design.html's request form (Lumina Creative Co graphic design service)
-- was the last page still writing to Firebase Firestore. This moves it
-- onto Supabase, following the same public-insert/admin-read shape as
-- `applications` (see policies.sql).

create table design_requests (
  id uuid primary key default gen_random_uuid(),
  full_name text,
  phone text,
  email text,
  design_type text,
  deadline date,
  budget text,
  description text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

alter table design_requests enable row level security;

create policy "design_requests_public_insert" on design_requests
  for insert with check (true);

create policy "design_requests_admin_read" on design_requests
  for select using (is_admin(auth.uid()));

create policy "design_requests_admin_write" on design_requests
  for update using (is_admin(auth.uid()))
  with check (is_admin(auth.uid()));
