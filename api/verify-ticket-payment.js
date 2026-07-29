import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// This endpoint is read-only. Crediting a ticket purchase happens exactly
// once, in api/hubtel-callback.js via process_hubtel_payment. This just
// displays what that webhook already recorded — retrying briefly in case
// the browser lands here before the async webhook call does.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ status: false, message: 'Method not allowed' });
  }

  const reference = String(req.query.reference || '').trim();

  if (!reference) {
    return res.status(400).json({ status: false, message: 'Missing payment reference' });
  }

  try {
    let payment = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const { data, error } = await supabase
        .from('payment_transactions')
        .select('*')
        .eq('client_reference', reference)
        .eq('type', 'ticket')
        .maybeSingle();

      if (error) throw error;

      if (data) {
        payment = data;
        break;
      }

      await sleep(2000);
    }

    if (!payment) {
      return res.status(202).json({
        status: false,
        processing: true,
        message: 'Your payment is still being confirmed. Please check back in a moment.'
      });
    }

    const { data: event } = await supabase
      .from('events')
      .select('event_name, event_code, event_date, location, contact_phone')
      .eq('id', payment.event_id)
      .maybeSingle();

    let ticketName = 'Regular Ticket';
    if (payment.ticket_type_id) {
      const { data: ticketType } = await supabase
        .from('event_ticket_types')
        .select('name')
        .eq('id', payment.ticket_type_id)
        .maybeSingle();

      if (ticketType?.name) ticketName = ticketType.name;
    }

    res.status(200).json({
      status: true,
      message: 'Ticket payment verified',
      alreadyProcessed: false,
      data: {
        eventId: payment.event_id,
        eventName: event?.event_name || '',
        eventCode: event?.event_code || '',
        eventDate: event?.event_date || '',
        location: event?.location || '',
        contactPhone: event?.contact_phone || '',
        ticketName,
        quantity: payment.quantity || 0
      }
    });

  } catch (error) {
    console.error('Verify ticket payment error:', error);
    res.status(500).json({ status: false, message: error.message || 'Ticket payment verification failed' });
  }
}
