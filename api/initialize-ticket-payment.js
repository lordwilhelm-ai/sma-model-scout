import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const fetch = globalThis.fetch;

function normalizeStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'active' || s === 'live') return 'active';
  if (s === 'upcoming') return 'upcoming';
  if (s === 'paused') return 'paused';
  return 'closed';
}

function hasTickets(eventData) {
  return (
    eventData?.tickets_enabled === true ||
    eventData?.event_type === 'tickets' ||
    eventData?.event_type === 'voting_tickets'
  );
}

// Hubtel caps ClientReference at 32 characters. eventId alone (a Postgres
// uuid) is 36, so a naive `ticket_${eventId}_...`.slice(0, 32) truncates
// straight through the uuid and drops the quantity/timestamp suffix
// entirely — every purchase for the same event then produces the exact
// same ClientReference, colliding on pending_transactions' primary key
// whenever two purchases for that event are pending at once. Use a short
// random reference instead, same as api/pay/initialize.js.
function shortRef(prefix) {
  const rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `${prefix}_${rand}`.slice(0, 32);
}

function getSiteUrl(req) {
  const override = process.env.HUBTEL_SITE_URL || process.env.SITE_URL;
  if (override && typeof override === 'string' && override.trim()) {
    return override.trim().replace(/\/$/, '');
  }
  const host = req.headers?.host || '';
  const proto = req.headers?.['x-forwarded-proto'] || req.headers?.['x-forwarded-protocol'] || 'https';
  if (!host) return 'https://example.com';
  return `${proto}://${host.replace(/\/$/, '')}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const body = req.body || {};

    const email = String(body.email || '').trim();
    const metadata = body.metadata || {};
    const eventId = String(metadata.eventId || '').trim();
    const quantity = Number(metadata.quantity || 0);
    const ticketTypeId = metadata.ticketTypeId && metadata.ticketTypeId !== 'legacy' ? metadata.ticketTypeId : null;

    if (!email) return res.status(400).json({ message: 'Email is required' });
    if (!eventId || !quantity || quantity < 1) {
      return res.status(400).json({ message: 'Ticket details are missing or invalid' });
    }

    const clientId = process.env.HUBTEL_CLIENT_ID;
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET;
    const merchantAccountNumber = String(process.env.HUBTEL_MERCHANT_ACCOUNT || '').trim();

    if (!clientId || !clientSecret) {
      return res.status(500).json({ message: 'HUBTEL_CLIENT_ID or HUBTEL_CLIENT_SECRET is missing' });
    }
    if (!merchantAccountNumber) {
      return res.status(500).json({ message: 'HUBTEL_MERCHANT_ACCOUNT is missing' });
    }

    const { data: eventData, error: eventError } = await supabase
      .from('events').select('*').eq('id', eventId).maybeSingle();

    if (eventError) throw eventError;
    if (!eventData) return res.status(404).json({ message: 'Event not found' });

    if (!hasTickets(eventData)) return res.status(400).json({ message: 'Tickets are not enabled for this event' });
    if (normalizeStatus(eventData.status) !== 'active') {
      return res.status(400).json({ message: 'This event is not active for ticket sales' });
    }

    const ticketQuantity = Number(eventData.ticket_quantity || 0);
    const ticketsSold = Number(eventData.tickets_sold || 0);
    const availableTickets = Math.max(ticketQuantity - ticketsSold, 0);

    if (quantity > availableTickets) {
      return res.status(400).json({ message: 'Not enough tickets available' });
    }

    let ticketPrice = Number(eventData.ticket_price || 0);
    if (isNaN(ticketPrice) || ticketPrice < 1) ticketPrice = 1;

    const amount = Number((quantity * ticketPrice).toFixed(2));

    if (amount < 1) {
      return res.status(400).json({ message: 'Amount is invalid. Minimum is GHS 1.00' });
    }

    const siteUrl = getSiteUrl(req);
    const callbackUrl = process.env.HUBTEL_CALLBACK_URL || `${siteUrl}/api/hubtel-callback`;
    // NOTE: HUBTEL_RETURN_URL is vote-specific (points at vote-success.html),
    // so it's deliberately not used here — tickets need their own return page.
    const returnUrl = `${siteUrl}/ticket-success.html`;
    const cancellationUrl = process.env.HUBTEL_CANCELLATION_URL || `${siteUrl}/voting-home.html`;

    const phone = String(metadata.phone || '').trim();
    const clientReference = shortRef('ticket');

    const payload = {
      totalAmount: amount,
      description: `Tickets for ${eventData.event_name || 'Event'} - Qty: ${quantity}`,
      callbackUrl,
      returnUrl,
      cancellationUrl,
      merchantAccountNumber,
      clientReference,
      ...(phone ? { payeeMobileNumber: phone } : {}),
      payeeName: email,
    };

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await fetch('https://payproxyapi.hubtel.com/items/initiate', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) {
      console.error('Hubtel init parse error', e, 'text:', text);
      return res.status(500).json({ message: 'Invalid response from Hubtel', raw: text });
    }

    if (!response.ok) {
      const message = data?.message || data?.description || 'Hubtel ticket initialization failed';
      const debug = { status: response.status, raw: data };
      if (response.status === 401) debug.note = 'Unauthorized. Verify Hubtel keys and merchant account access.';
      if (response.status === 400) debug.note = 'Validation error. Check amount and merchantAccountNumber';
      return res.status(response.status).json({ message, ...debug });
    }

    const paymentUrl = data?.data?.checkoutUrl || data?.checkoutUrl;

    if (!paymentUrl) {
      return res.status(500).json({ message: 'No checkout URL returned by Hubtel', raw: data });
    }

    const { error: pendingError } = await supabase.from('pending_transactions').insert({
      key: clientReference,
      type: 'ticket',
      event_id: eventId,
      ticket_type_id: ticketTypeId,
      phone_number: phone || null,
      buyer_email: email || null,
      ticket_price: ticketPrice,
      amount,
      status: 'pending'
    });

    if (pendingError) {
      console.error('pending_transactions insert error:', pendingError);
      return res.status(500).json({ message: 'Could not record pending ticket order' });
    }

    res.status(200).json({
      success: true,
      message: 'Ticket payment initialized successfully',
      data: {
        authorization_url: paymentUrl,
        checkoutId: data?.data?.checkoutId,
        clientReference,
        raw: data,
      },
    });

  } catch (error) {
    console.error('Initialize ticket payment error:', error);
    res.status(500).json({ message: error.message || 'Ticket payment initialization failed' });
  }
}
