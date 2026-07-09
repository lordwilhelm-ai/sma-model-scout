import admin from 'firebase-admin';
const fetch = globalThis.fetch;

function initFirebaseAdmin() {
  if (admin.apps.length) return;
  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!base64) throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 is missing');
  const serviceAccount = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

function normalizeHubtelStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'success' || s === 'successful' || s === 'completed' || s === 'paid' || s === '0000' || s === '000';
}

function extractHubtelMetadata(payload) {
  if (!payload || typeof payload!== 'object') return {};
  const candidates = [
    payload.metadata, payload.Metadata, payload.data?.metadata,
    payload.data?.Metadata, payload.Data?.metadata, payload.Data?.Metadata,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') return candidate;
  }
  return {};
}

function hasTickets(eventData) {
  return eventData?.ticketsEnabled === true || eventData?.type === 'tickets' || eventData?.type === 'voting_tickets';
}

export default async function handler(req, res) {
  if (req.method!== 'GET') {
    return res.status(405).json({ status: false, message: 'Method not allowed' });
  }

  try {
    initFirebaseAdmin();
    const db = admin.firestore();
    const reference = String(req.query.reference || '').trim();

    if (!reference) {
      return res.status(400).json({ status: false, message: 'Missing payment reference' });
    }

    const clientId = process.env.HUBTEL_CLIENT_ID;
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET;

    if (!clientId ||!clientSecret) {
      return res.status(500).json({ status: false, message: 'HUBTEL_CLIENT_ID or HUBTEL_CLIENT_SECRET missing' });
    }

    // FIX 1: Use correct Hubtel verify endpoint
    const response = await fetch(
      `https://payproxyapi.hubtel.com/transactions/${encodeURIComponent(reference)}/status`,
      {
        method: 'GET',
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const text = await response.text();
    let hubtelJson = null;
    try { hubtelJson = JSON.parse(text) } catch(e) {
      return res.status(500).json({ status: false, message: 'Invalid response from Hubtel', raw: text });
    }

    const paymentData = hubtelJson.data || hubtelJson.Data || hubtelJson;
    const paymentStatus = paymentData?.status || paymentData?.Status || hubtelJson?.responseCode || hubtelJson?.ResponseCode;
    const clientReference = paymentData?.clientReference || paymentData?.ClientReference || reference;

    if (!response.ok ||!normalizeHubtelStatus(paymentStatus)) {
      return res.status(response.status || 400).json({
        status: false,
        message: hubtelJson.description || hubtelJson.message || 'Could not verify ticket payment',
        hubtel: hubtelJson,
      });
    }

    // FIX 2: Fallback parse metadata from ClientReference if missing
    let metadata = extractHubtelMetadata(hubtelJson) || extractHubtelMetadata(paymentData) || {};
    if (!metadata.eventId && clientReference.startsWith('ticket_')) {
      const parts = clientReference.split('_');
      if (parts.length >= 3) {
        metadata = {
          eventId: parts[1],
          quantity: Number(parts[2]),
        }
      }
    }

    const eventId = String(metadata.eventId || '').trim();
    const quantity = Number(metadata.quantity || 0);

    if (!eventId ||!quantity || quantity < 1) {
      return res.status(400).json({ status: false, message: 'Payment verified, but ticket details are missing' });
    }

    const result = await db.runTransaction(async (transaction) => {
      const paymentRef = db.collection('ticketPayments').doc(reference);
      const eventRef = db.collection('events').doc(eventId);

      const [paymentSnap, eventSnap] = await Promise.all([
        transaction.get(paymentRef),
        transaction.get(eventRef),
      ]);

      if (paymentSnap.exists) {
        const existing = paymentSnap.data() || {};
        return {
          alreadyProcessed: true,
          eventId: existing.eventId || eventId,
          eventName: existing.eventName || metadata.eventName || '',
          quantity: Number(existing.quantity || quantity),
        };
      }

      if (!eventSnap.exists) throw new Error('Event not found');
      const eventData = eventSnap.data() || {};

      if (!hasTickets(eventData)) throw new Error('Tickets are not enabled for this event');
      if (String(eventData.status).toLowerCase()!== 'active') throw new Error('This event is not active for ticket sales');

      const ticketQuantity = Number(eventData.ticketQuantity || 0);
      const ticketsSold = Number(eventData.ticketsSold || 0);
      const availableTickets = Math.max(ticketQuantity - ticketsSold, 0);

      if (quantity > availableTickets) throw new Error('Not enough tickets available');

      let ticketPrice = Number(eventData.ticketPrice || metadata.ticketPrice || 1);
      if (isNaN(ticketPrice) || ticketPrice < 1) ticketPrice = 1;

      // FIX 3: Hubtel returns amount in GHS, not pesewas
      const expectedAmount = Number((quantity * ticketPrice).toFixed(2));
      const paidAmount = Number(paymentData.amount || paymentData.totalAmount || 0);

      if (paidAmount < expectedAmount) {
        throw new Error(`Paid amount GHS ${paidAmount} is lower than expected GHS ${expectedAmount}`);
      }

      const safeEventName = metadata.eventName || eventData.eventName || '';
      const safeTicketName = metadata.ticketName || 'Regular Ticket';

      transaction.set(paymentRef, {
        reference,
        clientReference,
        eventId,
        eventName: safeEventName,
        ticketName: safeTicketName,
        ticketPrice,
        quantity,
        amount: paidAmount,
        expectedAmount,
        currency: paymentData.currency || 'GHS',
        status: 'paid',
        paidAt: paymentData.paidAt || admin.firestore.FieldValue.serverTimestamp(),
        channel: paymentData.channel || '',
        customerEmail: paymentData.customer?.email || '',
        source: metadata.source || 'verify_ticket_endpoint',
        processedBy: 'vercel_verify_ticket_payment',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // FIX 3: Increment by GHS amount, not pesewas
      transaction.update(eventRef, {
        ticketsSold: admin.firestore.FieldValue.increment(quantity),
        ticketSalesAmount: admin.firestore.FieldValue.increment(paidAmount),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        alreadyProcessed: false,
        eventId,
        eventName: safeEventName,
        ticketName: safeTicketName,
        ticketPrice,
        quantity,
      };
    });

    res.status(200).json({
      status: true,
      message: result.alreadyProcessed? 'Ticket payment already processed' : 'Ticket payment verified and tickets added',
      alreadyProcessed: result.alreadyProcessed,
      data: result,
    });

  } catch (error) {
    console.error('Verify ticket payment error:', error);
    res.status(500).json({ status: false, message: error.message || 'Ticket payment verification failed' });
  }
}