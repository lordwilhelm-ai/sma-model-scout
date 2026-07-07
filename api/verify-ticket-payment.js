import admin from 'firebase-admin';
import fetch from 'node-fetch';

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

function normalizeHubtelStatus(status) {
  const s = String(status || '').toLowerCase();
  return (
    s === 'success' ||
    s === 'successful' ||
    s === 'completed' ||
    s === 'paid' ||
    s === '0000' ||
    s === '000'
  );
}

function extractHubtelMetadata(payload) {
  if (!payload || typeof payload !== 'object') return {};

  const candidates = [
    payload.metadata,
    payload.Metadata,
    payload.data?.metadata,
    payload.data?.Metadata,
    payload.Data?.metadata,
    payload.Data?.Metadata,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      return candidate;
    }
  }

  return {};
}

function hasTickets(eventData) {
  return (
    eventData?.ticketsEnabled === true ||
    eventData?.type === 'tickets' ||
    eventData?.type === 'voting_tickets'
  );
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ status: false, message: 'Method not allowed' });
    return;
  }

  try {
    initFirebaseAdmin();

    const db = admin.firestore();
    const reference = String(req.query.reference || '').trim();

    if (!reference) {
      res.status(400).json({ status: false, message: 'Missing payment reference' });
      return;
    }

    const clientId = process.env.HUBTEL_CLIENT_ID;
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      res.status(500).json({ status: false, message: 'HUBTEL_CLIENT_ID or HUBTEL_CLIENT_SECRET missing' });
      return;
    }

    const response = await fetch(
      `https://api-txnverify.hubtel.com/v1/transactions/${encodeURIComponent(reference)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const hubtelJson = await response.json();
    const paymentData = hubtelJson.data || hubtelJson.Data || hubtelJson;
    const paymentStatus = paymentData?.status || paymentData?.Status || hubtelJson?.responseCode || hubtelJson?.ResponseCode;

    if (!response.ok || !normalizeHubtelStatus(paymentStatus)) {
      res.status(response.status || 400).json({
        status: false,
        message: hubtelJson.description || hubtelJson.message || 'Could not verify ticket payment',
        hubtel: hubtelJson,
      });
      return;
    }

    const metadata = extractHubtelMetadata(hubtelJson) || extractHubtelMetadata(paymentData) || {};
    const eventId = String(metadata.eventId || '').trim();
    const quantity = Number(metadata.quantity || 0);

    if (!eventId || !quantity || quantity < 1) {
      res.status(400).json({ status: false, message: 'Payment verified, but ticket details are missing' });
      return;
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
          eventCode: existing.eventCode || metadata.eventCode || '',
          ticketName: existing.ticketName || metadata.ticketName || 'Regular Ticket',
          ticketPrice: Number(existing.ticketPrice || metadata.ticketPrice || 0),
          quantity: Number(existing.quantity || quantity),
          location: existing.location || metadata.location || '',
          eventDate: existing.eventDate || metadata.eventDate || '',
          contactPhone: existing.contactPhone || metadata.contactPhone || '',
        };
      }

      if (!eventSnap.exists) {
        throw new Error('Event not found');
      }

      const eventData = eventSnap.data() || {};

      if (!hasTickets(eventData)) {
        throw new Error('Tickets are not enabled for this event');
      }

      if (normalizeHubtelStatus(eventData.status) !== 'active') {
        throw new Error('This event is not active for ticket sales');
      }

      const ticketQuantity = Number(eventData.ticketQuantity || 0);
      const ticketsSold = Number(eventData.ticketsSold || 0);
      const availableTickets = Math.max(ticketQuantity - ticketsSold, 0);

      if (quantity > availableTickets) {
        throw new Error('Not enough tickets available');
      }

      let ticketPrice = Number(eventData.ticketPrice || metadata.ticketPrice || 0);

      if (isNaN(ticketPrice) || ticketPrice < 1) {
        ticketPrice = 1;
      }

      const expectedAmount = Math.round(quantity * ticketPrice * 100);
      const paidAmount = Number(paymentData.amount || paymentData.totalAmount || paymentData.TotalAmount || paymentData.Amount || 0);

      if (paidAmount < expectedAmount) {
        throw new Error('Paid amount is lower than expected ticket amount');
      }

      const safeEventCode = metadata.eventCode || eventData.eventCode || '';
      const safeEventName = metadata.eventName || eventData.eventName || '';
      const safeTicketName = metadata.ticketName || eventData.ticketName || 'Regular Ticket';
      const safeLocation = metadata.location || eventData.location || '';
      const safeEventDate = metadata.eventDate || eventData.eventDate || '';
      const safeContactPhone = metadata.contactPhone || eventData.contactPhone || '';

      transaction.set(paymentRef, {
        reference,
        eventId,
        eventCode: safeEventCode,
        eventName: safeEventName,
        ticketName: safeTicketName,
        ticketPrice,
        quantity,
        amount: paidAmount,
        expectedAmount,
        currency: paymentData.currency || paymentData.Currency || 'GHS',
        status: paymentStatus,
        paidAt: paymentData.paidAt || paymentData.PaidAt || paymentData.paid_at || null,
        channel: paymentData.channel || paymentData.Channel || '',
        customerEmail: paymentData.customer?.email || paymentData.CustomerEmail || '',
        location: safeLocation,
        eventDate: safeEventDate,
        contactPhone: safeContactPhone,
        source: metadata.source || 'lumina_ticket_checkout',
        processedBy: 'vercel_verify_ticket_payment',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      transaction.update(eventRef, {
        ticketsSold: admin.firestore.FieldValue.increment(quantity),
        ticketSalesAmount: admin.firestore.FieldValue.increment(paidAmount / 100),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        alreadyProcessed: false,
        eventId,
        eventName: safeEventName,
        eventCode: safeEventCode,
        ticketName: safeTicketName,
        ticketPrice,
        quantity,
        location: safeLocation,
        eventDate: safeEventDate,
        contactPhone: safeContactPhone,
      };
    });

    res.status(200).json({
      status: true,
      message: result.alreadyProcessed
        ? 'Ticket payment already processed'
        : 'Ticket payment verified and tickets added',
      alreadyProcessed: result.alreadyProcessed,
      data: result,
    });
  } catch (error) {
    console.error('Verify ticket payment error:', error);
    res.status(500).json({ status: false, message: error.message || 'Ticket payment verification failed' });
  }
}
