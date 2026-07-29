-- Adds per-unit ticket records (one row per individual ticket, not per purchase)
-- so each ticket gets its own QR code and can be checked in independently.
--
-- Design:
--   - event_tickets: one row per ticket unit. status starts 'valid', flips to
--     'used' exactly once, at the door, via api/checkin-ticket.js (service-role
--     only — no client update policy exists on this table at all).
--   - The public "view my ticket" page (ticket-status.html) only ever reads via
--     api/ticket-status.js (also service-role), so opening/scanning it never
--     mutates anything — only the organizer-authenticated check-in endpoint does.
--   - process_hubtel_payment now creates one event_tickets row per unit
--     purchased and returns their ids (plus buyer email / event info) so
--     api/hubtel-callback.js can email the QR codes right after crediting.
--
-- Run this once via the Supabase SQL editor (schema.sql/policies.sql/functions.sql
-- and migrations 002-006 were already applied on prior passes).

alter table pending_transactions add column buyer_email text;

create table event_tickets (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  ticket_type_id uuid references event_ticket_types(id) on delete set null,
  client_reference text not null references payment_transactions(client_reference) on delete cascade,
  buyer_email text,
  buyer_phone text,
  status text not null default 'valid' check (status in ('valid', 'used')),
  used_at timestamptz,
  used_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index idx_event_tickets_event_id on event_tickets(event_id);
create index idx_event_tickets_client_reference on event_tickets(client_reference);

alter table event_tickets enable row level security;

-- Read-only for organizers (their own events) and admins, e.g. to show a
-- checked-in/valid count in the dashboard. No insert/update/delete policies
-- for anon/authenticated at all — every write goes through the service-role
-- client in api/checkin-ticket.js, which enforces the atomic "only if still
-- valid" guard and the organizer/admin authorization check itself.
create policy "event_tickets_admin_read" on event_tickets
  for select using (is_admin(auth.uid()));

create policy "event_tickets_organizer_read" on event_tickets
  for select using (
    event_id in (select id from events where organizer_id = auth.uid())
  );

create or replace function process_hubtel_payment(
  p_client_reference text,
  p_type text,
  p_key text,
  p_amount numeric,
  p_phone text default null,
  p_checkout_id text default null,
  p_sales_invoice_id text default null,
  p_transaction_id text default null,
  p_description text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_pending pending_transactions%rowtype;
  v_event events%rowtype;
  v_contestant_id uuid;
  v_event_id uuid;
  v_votes int;
  v_quantity int;
  v_ticket_ids uuid[];
  v_ticket_type_name text;
begin
  if exists (select 1 from payment_transactions where client_reference = p_client_reference) then
    return jsonb_build_object('status', 'already_saved');
  end if;

  select * into v_pending from pending_transactions where key = p_key for update;
  if not found then
    return jsonb_build_object('status', 'error', 'message', 'pending not found');
  end if;

  if p_type in ('vote', 'ussd_vote') then
    if v_pending.contestant_id is not null then
      v_contestant_id := v_pending.contestant_id;
      v_event_id := v_pending.event_id;
    elsif v_pending.contestant_code is not null then
      select id, event_id into v_contestant_id, v_event_id
        from event_contestants
        where nominee_code = v_pending.contestant_code
        limit 1;
    end if;

    if v_contestant_id is null then
      return jsonb_build_object('status', 'error', 'message', 'contestant not found for pending payment');
    end if;

    perform 1 from event_contestants where id = v_contestant_id for update;

    select * into v_event from events where id = v_event_id for update;
    if not found then
      return jsonb_build_object('status', 'error', 'message', 'event not found');
    end if;

    v_votes := floor(p_amount / coalesce(v_event.vote_price, 1));
    if v_votes < 1 then
      return jsonb_build_object('status', 'error', 'message', 'amount below vote price');
    end if;

    insert into payment_transactions (
      client_reference, type, source, event_id, contestant_id, votes, amount,
      vote_price_used, phone_number, channel, checkout_id, sales_invoice_id,
      transaction_id, description, session_id, status
    ) values (
      p_client_reference, p_type,
      case when p_type = 'ussd_vote' then 'ussd' else 'web' end,
      v_event_id, v_contestant_id, v_votes, p_amount,
      v_event.vote_price, coalesce(p_phone, v_pending.phone_number), p_type,
      p_checkout_id, p_sales_invoice_id, p_transaction_id, p_description,
      case when p_type = 'ussd_vote' then p_key else null end, 'paid'
    )
    on conflict (client_reference) do nothing;

    if not found then
      return jsonb_build_object('status', 'already_saved');
    end if;

    update event_contestants
      set votes = votes + v_votes, total_amount = total_amount + p_amount
      where id = v_contestant_id;

    update events set total_votes = total_votes + v_votes where id = v_event_id;

  elsif p_type = 'ticket' then
    select * into v_event from events where id = v_pending.event_id for update;
    if not found then
      return jsonb_build_object('status', 'error', 'message', 'event not found');
    end if;

    v_quantity := floor(p_amount / coalesce(v_pending.ticket_price, 1));
    if v_quantity < 1 then
      return jsonb_build_object('status', 'error', 'message', 'amount below ticket price');
    end if;

    insert into payment_transactions (
      client_reference, type, event_id, ticket_type_id, quantity, amount,
      phone_number, checkout_id, sales_invoice_id, transaction_id, description, status
    ) values (
      p_client_reference, 'ticket', v_pending.event_id, v_pending.ticket_type_id, v_quantity, p_amount,
      coalesce(p_phone, v_pending.phone_number), p_checkout_id, p_sales_invoice_id,
      p_transaction_id, p_description, 'paid'
    )
    on conflict (client_reference) do nothing;

    if not found then
      return jsonb_build_object('status', 'already_saved');
    end if;

    update events
      set tickets_sold = tickets_sold + v_quantity,
          ticket_sales_amount = ticket_sales_amount + p_amount
      where id = v_pending.event_id;

    if v_pending.ticket_type_id is not null then
      update event_ticket_types
        set sold = sold + v_quantity, sales_amount = sales_amount + p_amount
        where id = v_pending.ticket_type_id;

      select name into v_ticket_type_name from event_ticket_types where id = v_pending.ticket_type_id;
    else
      v_ticket_type_name := 'Regular Ticket';
    end if;

    with ins as (
      insert into event_tickets (event_id, ticket_type_id, client_reference, buyer_email, buyer_phone)
      select v_pending.event_id, v_pending.ticket_type_id, p_client_reference,
             v_pending.buyer_email, coalesce(p_phone, v_pending.phone_number)
      from generate_series(1, v_quantity)
      returning id
    )
    select array_agg(id) into v_ticket_ids from ins;

    delete from pending_transactions where key = p_key;

    return jsonb_build_object(
      'status', 'ok',
      'ticket_ids', to_jsonb(v_ticket_ids),
      'buyer_email', v_pending.buyer_email,
      'event_name', v_event.event_name,
      'event_date', v_event.event_date,
      'location', v_event.location,
      'ticket_type_name', v_ticket_type_name,
      'quantity', v_quantity
    );

  else
    return jsonb_build_object('status', 'error', 'message', 'unknown type');
  end if;

  delete from pending_transactions where key = p_key;

  return jsonb_build_object('status', 'ok');
end;
$$;
