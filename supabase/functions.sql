-- sma-model-scout: process_hubtel_payment
-- Replaces the Firestore runTransaction block in api/hubtel-callback.js.
-- Called once per callback via supabase.rpc('process_hubtel_payment', {...})
-- using the service-role client. The whole function body runs as one
-- implicit transaction with row locks (SELECT ... FOR UPDATE), giving the
-- same atomicity + idempotency guarantees Firestore's transaction gave.
--
-- This is the ONLY place votes/tickets get credited. api/verify-ticket-payment.js
-- is read-only and just displays what this function already recorded.

create or replace function process_hubtel_payment(
  p_client_reference text,
  p_type text,               -- 'vote' | 'ussd_vote' | 'ticket'
  p_key text,                 -- pending_transactions lookup key (client_reference or ussd sessionId)
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
  -- Idempotency: if we've already recorded this reference, don't double-credit.
  if exists (select 1 from payment_transactions where client_reference = p_client_reference) then
    return jsonb_build_object('status', 'already_saved');
  end if;

  select * into v_pending from pending_transactions where key = p_key for update;
  if not found then
    return jsonb_build_object('status', 'error', 'message', 'pending not found');
  end if;

  if p_type in ('vote', 'ussd_vote') then
    if v_pending.contestant_id is not null then
      -- web vote checkout: contestant already resolved when the pending row was created
      v_contestant_id := v_pending.contestant_id;
      v_event_id := v_pending.event_id;
    elsif v_pending.contestant_code is not null then
      -- USSD: voter entered a short nominee_code with no event context, so
      -- resolve it now. Ambiguous if the same code exists in multiple events.
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
      -- lost a race to a concurrent callback with the same reference
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
