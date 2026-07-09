import admin from 'firebase-admin';
const fetch = globalThis.fetch;

function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!base64) throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 is missing');

  const serviceAccount = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

function normalizeStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'active' || s === 'live') return 'active';
  if (s === 'upcoming') return 'upcoming';
  if (s === 'paused') return 'paused';
  return 'closed';
}

function hasTickets(eventData) {
  return (
    eventData?.ticketsEnabled === true ||
    eventData?.type === 'tickets' ||
    eventData?.type === 'voting_tickets'
  );
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
    initFirebaseAdmin();
    const db = admin.firestore();
    const body = req.body || {};

    const email = String(body.email || '').trim();
    const metadata = body.metadata || {};
    const eventId = String(metadata.eventId || '').trim();
    const quantity = Number(metadata.quantity || 0);

    if (!email) return res.status(400).json({ message: 'Email is required' });
    if (!eventId || !quantity || quantity < 1) {
      return res.status(400).json({ message: 'Ticket details are missing or invalid' });
    }

    const clientId = process.env.HUBTEL_CLIENT_ID;
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET;
    const merchantAccountNumber = String(process.env.HUBTEL_MERCHANT_ACCOUNT || '').trim(); // FIX 1

    if (!clientId || !clientSecret) {
      return res.status(500).json({ message: 'HUBTEL_CLIENT_ID or HUBTEL_CLIENT_SECRET is missing' });
    }
    if (!merchantAccountNumber) {
      return res.status(500).json({ message: 'HUBTEL_MERCHANT_ACCOUNT is missing' });
    }

    const eventSnap = await db.collection('events').doc(eventId).get();
    if (!eventSnap.exists) return res.status(404).json({ message: 'Event not found' });

    const eventData = eventSnap.data() || {};
    if (!hasTickets(eventData)) return res.status(400).json({ message: 'Tickets are not enabled for this event' });
    if (normalizeStatus(eventData.status) !== 'active') {
      return res.status(400).json({ message: 'This event is not active for ticket sales' });
    }

    const ticketQuantity = Number(eventData.ticketQuantity || 0);
    const ticketsSold = Number(eventData.ticketsSold || 0);
    const availableTickets = Math.max(ticketQuantity - ticketsSold, 0);

    if (quantity > availableTickets) {
      return res.status(400).json({ message: 'Not enough tickets available' });
    }

    let ticketPrice = Number(eventData.ticketPrice || 0);
    if (isNaN(ticketPrice) || ticketPrice < 1) ticketPrice = 1;

    const amount = Number((quantity * ticketPrice).toFixed(2)); // FIX 3: GHS with 2 decimals

    if (amount < 1) {
      return res.status(400).json({ message: 'Amount is invalid. Minimum is GHS 1.00' });
    }

    const siteUrl = getSiteUrl(req);
    const callbackUrl = process.env.HUBTEL_CALLBACK_URL || `${siteUrl}/api/hubtel-callback`;
    const returnUrl = process.env.HUBTEL_RETURN_URL || `${siteUrl}/success.html`;
    const cancellationUrl = process.env.HUBTEL_CANCELLATION_URL || `${siteUrl}/voting-home.html`;

    const phone = String(metadata.phone || '').trim();
    const clientReference = `ticket_${eventId}_${quantity}_${Date.now()}`.slice(0, 32); // max 32 chars

    const payload = {
      totalAmount: amount,
      description: `Tickets for ${eventData.name || 'Event'} - Qty: ${quantity}`,
      callbackUrl,
      returnUrl,
      cancellationUrl,
      merchantAccountNumber, // FIX 1
      clientReference,
      ...(phone ? { payeeMobileNumber: phone } : {}), // FIX 2
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
      if (response.status === 401) debug.note = 'Unauthorized. Verify keys for merchant 2039825';
      if (response.status === 400) debug.note = 'Validation error. Check amount and merchantAccountNumber';
      return res.status(response.status).json({ message, ...debug });
    }

    const paymentUrl = data?.data?.checkoutUrl || data?.checkoutUrl;

    if (!paymentUrl) {
      return res.status(500).json({ message: 'No checkout URL returned by Hubtel', raw: data });
    }

    // Save pending ticket order to Firestore
    await db.collection('pending_ticket_orders').doc(clientReference).set({
      eventId,
      email,
      quantity,
      amount,
      ticketPrice,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

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