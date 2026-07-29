-- Adds ticket_type_id tracking to the payment ledger (so ticket-success.html
-- can show which ticket type was bought when an event has more than one),
-- and rewrites process_hubtel_payment to:
--   1) resolve USSD votes via nominee_code (the voter only enters a short
--      code with no event context, so this happens at credit time), and
--   2) carry ticket_type_id from pending_transactions into payment_transactions
--      and increment that specific event_ticket_types row's sold/sales_amount.
--
-- Run this once via the Supabase SQL editor (schema.sql/policies.sql/functions.sql
-- and migrations 002-004 were already applied on prior passes).

alter table pending_transactions add column ticket_type_id uuid references event_ticket_types(id) on delete set null;
alter table payment_transactions add column ticket_type_id uuid references event_ticket_types(id) on delete set null;

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
    end if;

  else
    return jsonb_build_object('status', 'error', 'message', 'unknown type');
  end if;

  delete from pending_transactions where key = p_key;

  return jsonb_build_object('status', 'ok');
end;
$$;
