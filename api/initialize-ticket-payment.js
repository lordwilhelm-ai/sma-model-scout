import admin from 'firebase-admin';
const fetch = globalThis.fetch;

function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  if (!base64) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 is missing');
  }

  const serviceAccount = JSON.parse(
    Buffer.from(base64, 'base64').toString('utf8')
  );

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
  const proto =
    req.headers?.['x-forwarded-proto'] || req.headers?.['x-forwarded-protocol'] || 'https';
  if (!host) return 'https://example.com';
  return `${proto}://${host.replace(/\/$/, '')}`;
}

function extractHubtelPaymentUrl(data) {
  if (!data || typeof data !== 'object') return '';

  const candidates = [
    data.paymentUrl,
    data.payment_url,
    data.authorizationUrl,
    data.authorization_url,
    data.redirectUrl,
    data.redirect_url,
    data.url,
    data.checkoutUrl,
    data.checkout_url,
    data.link,
    data.paymentLink,
    data.payment_link,
    data?.data?.paymentUrl,
    data?.data?.payment_url,
    data?.data?.authorizationUrl,
    data?.data?.authorization_url,
    data?.data?.redirectUrl,
    data?.data?.redirect_url,
    data?.data?.url,
    data?.data?.checkoutUrl,
    data?.data?.checkout_url,
    data?.data?.link,
    data?.data?.paymentLink,
    data?.data?.payment_link,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ message: 'Method not allowed' });
    return;
  }

  try {
    initFirebaseAdmin();

    const db = admin.firestore();
    const body = req.body || {};

    const email = String(body.email || '').trim();
    const metadata = body.metadata || {};

    const eventId = String(metadata.eventId || '').trim();
    const quantity = Number(metadata.quantity || 0);

    if (!email) {
      res.status(400).json({ message: 'Email is required' });
      return;
    }

    if (!eventId || !quantity || quantity < 1) {
      res.status(400).json({ message: 'Ticket details are missing or invalid' });
      return;
    }

    const clientId = process.env.HUBTEL_CLIENT_ID;
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      res.status(500).json({ message: 'HUBTEL_CLIENT_ID or HUBTEL_CLIENT_SECRET is missing' });
      return;
    }

    const eventSnap = await db.collection('events').doc(eventId).get();

    if (!eventSnap.exists) {
      res.status(404).json({ message: 'Event not found' });
      return;
    }

    const eventData = eventSnap.data() || {};

    if (!hasTickets(eventData)) {
      res.status(400).json({ message: 'Tickets are not enabled for this event' });
      return;
    }

    if (normalizeStatus(eventData.status) !== 'active') {
      res.status(400).json({ message: 'This event is not active for ticket sales' });
      return;
    }

    const ticketQuantity = Number(eventData.ticketQuantity || 0);
    const ticketsSold = Number(eventData.ticketsSold || 0);
    const availableTickets = Math.max(ticketQuantity - ticketsSold, 0);

    if (quantity > availableTickets) {
      res.status(400).json({ message: 'Not enough tickets available' });
      return;
    }

    let ticketPrice = Number(eventData.ticketPrice || 0);

    if (isNaN(ticketPrice) || ticketPrice < 1) {
      ticketPrice = 1;
    }

    const amount = Math.round(quantity * ticketPrice * 100);

    if (!amount || amount < 100) {
      res.status(400).json({ message: 'Amount is invalid. Minimum is GHS 1.00' });
      return;
    }

    const siteUrl = getSiteUrl(req);
    const callbackUrl =
      process.env.HUBTEL_CALLBACK_URL || `${siteUrl}/api/hubtel-callback`;
    const returnUrl =
      process.env.HUBTEL_RETURN_URL || `${siteUrl}/success.html`;
    const cancellationUrl =
      process.env.HUBTEL_CANCELLATION_URL || `${siteUrl}/voting-home.html`;
    const merchantAccountNumber = String(process.env.HUBTEL_MERCHANT_ACCOUNT_NUMBER || '').trim();

    const phone = String(metadata.phone || '').trim();
    const amountInGhanaCedis = amount / 100;

    const payload = {
      totalAmount: amountInGhanaCedis,
      description: metadata.description || 'Ticket Payment',
      callbackUrl,
      returnUrl,
      cancellationUrl,
      ...(phone ? { customerPhoneNumber: phone } : {}),
      clientReference: metadata.reference || `ticket-${Date.now()}`,
      ...(merchantAccountNumber ? { merchantAccountNumber } : {}),
    };

    const response = await fetch('https://payproxyapi.hubtel.com/items/initiate', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    const paymentUrl = extractHubtelPaymentUrl(data);

    if (!response.ok || !paymentUrl) {
      res.status(response.status || 400).json({
        message: data.description || data.message || 'Hubtel ticket initialization failed',
        hubtel: data,
      });
      return;
    }

    res.status(200).json({
      status: true,
      message: 'Ticket payment initialized successfully',
      data: {
        authorization_url: paymentUrl,
        raw: data,
      },
    });
  } catch (error) {
    console.error('Initialize ticket payment error:', error);
    res.status(500).json({ message: error.message || 'Ticket payment initialization failed' });
  }
}
