-- sma-model-scout: Postgres schema for Supabase migration (replaces Firestore)
-- Run this once via the Supabase SQL editor (or `supabase db push`) on a fresh project.
-- Order matters: profiles/admin first, then events, then everything that references events.

create extension if not exists "pgcrypto";

-- =========================================================
-- PROFILES (role-specific, id = auth.users.id)
-- =========================================================

create table organizers (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  email text,
  brand text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table contestants (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  email text,
  event_name text,
  contestant_number text,
  created_at timestamptz not null default now()
);

create table admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

-- security definer so it can check admin_users regardless of the caller's RLS visibility
create function is_admin(uid uuid) returns boolean
  language sql stable security definer
  set search_path = public
as $$
  select exists(select 1 from admin_users where user_id = uid)
$$;

-- =========================================================
-- CORE EVENT DATA
-- =========================================================

create table events (
  id uuid primary key default gen_random_uuid(),
  event_name text not null,
  event_code text not null unique,
  event_type text,
  voting_enabled boolean not null default true,
  tickets_enabled boolean not null default false,
  organizer_id uuid references organizers(id),
  organizer_name text,
  status text not null default 'active',
  description text,
  poster_url text,
  platform_commission numeric,
  payout_status text not null default 'pending',
  payout_notes text,
  payout_updated_at timestamptz,
  vote_price numeric not null default 1,
  end_date timestamptz,
  has_categories boolean not null default false,
  category_count int not null default 0,
  total_votes int not null default 0,
  ticket_name text,
  ticket_price numeric,
  ticket_quantity int,
  tickets_sold int not null default 0,
  ticket_sales_amount numeric not null default 0,
  event_date timestamptz,
  location text,
  contact_phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table event_categories (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  organizer_id uuid references organizers(id),
  category_code text,
  category_name text not null,
  created_at timestamptz not null default now(),
  unique (event_id, category_code)
);

create table event_contestants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  category_id uuid references event_categories(id),
  organizer_id uuid references organizers(id),
  full_name text not null,
  contestant_number text,
  nominee_code text,  -- short code voters dial/enter during USSD to pick this nominee
  category_code text,
  category_name text,
  photo_url text,
  votes int not null default 0,
  total_amount numeric not null default 0,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  unique (event_id, contestant_number),
  unique (event_id, nominee_code)
);

create table event_ticket_types (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  organizer_id uuid references organizers(id),
  ticket_type_code text,
  name text,
  price numeric not null,
  quantity int,
  sold int not null default 0,
  sales_amount numeric not null default 0,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =========================================================
-- STANDALONE / MISC
-- =========================================================

create table applications (
  id uuid primary key default gen_random_uuid(),
  full_name text,
  age int,
  gender text,
  contact text,
  parent_name text,
  parent_contact text,
  residence text,
  gps_address text,
  previous_agency text,
  agency_name text,
  reason text,
  momo_ref text,
  photo_url text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table platform_settings (
  id int primary key default 1 check (id = 1),
  platform_commission numeric not null default 0,
  updated_at timestamptz not null default now()
);

insert into platform_settings (id, platform_commission) values (1, 0)
  on conflict (id) do nothing;

-- =========================================================
-- PAYMENT LEDGER + PENDING QUEUE (service-role only, see policies.sql)
-- =========================================================

create table pending_transactions (
  key text primary key,               -- client_reference, or ussd sessionId
  type text not null check (type in ('vote','ussd_vote','ticket')),
  event_id uuid references events(id) on delete set null,
  contestant_id uuid references event_contestants(id) on delete set null,
  contestant_code text,               -- USSD-entered nominee_code, resolved to contestant_id at callback time
  ticket_type_id uuid references event_ticket_types(id) on delete set null,
  phone_number text,
  ticket_price numeric,
  amount numeric,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table payment_transactions (
  client_reference text primary key,  -- idempotency key
  type text not null check (type in ('vote','ussd_vote','ticket')),
  source text not null default 'web',
  event_id uuid references events(id) on delete set null,
  contestant_id uuid references event_contestants(id) on delete set null,
  ticket_type_id uuid references event_ticket_types(id) on delete set null,
  votes int,
  quantity int,
  amount numeric not null,
  vote_price_used numeric,
  phone_number text,
  payment_method text,
  channel text,
  checkout_id text,
  sales_invoice_id text,
  transaction_id text,
  description text,
  session_id text,
  status text not null default 'paid',
  created_at timestamptz not null default now()
);

-- =========================================================
-- INDEXES for common lookups
-- =========================================================

create index idx_event_categories_event_id on event_categories(event_id);
create index idx_event_contestants_event_id on event_contestants(event_id);
create index idx_event_contestants_category_id on event_contestants(category_id);
create index idx_event_ticket_types_event_id on event_ticket_types(event_id);
create index idx_events_organizer_id on events(organizer_id);
create index idx_payment_transactions_event_id on payment_transactions(event_id);
create index idx_payment_transactions_contestant_id on payment_transactions(contestant_id);
