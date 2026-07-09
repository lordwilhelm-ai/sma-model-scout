import admin from 'firebase-admin';
const fetch = globalThis.fetch;

function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!base64) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 is missing');
  }

  const serviceAccount = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
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
  if (!payload || typeof payload!== 'object') return {};
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

    // FIX 1: Correct Hubtel Transaction Verify endpoint
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
        message: hubtelJson.description || hubtelJson.message || 'Could not verify payment',
        hubtel: hubtelJson,
      });
    }

    // FIX 2: Get metadata from ClientReference if not in response
    let metadata = extractHubtelMetadata(hubtelJson) || extractHubtelMetadata(paymentData) || {};

    // If metadata empty, parse from ClientReference: vote_eventId_contestantId_votes_timestamp
    if (!metadata.eventId && clientReference.startsWith('vote_')) {
      const parts = clientReference.split('_');
      if (parts.length >= 4) {
        metadata = {
          eventId: parts[1],
          contestantId: parts[2],
          votesBought: Number(parts[3]),
        }
      }
    }
    if (!metadata.eventId && clientReference.startsWith('ticket_')) {
      const parts = clientReference.split('_');
      if (parts.length >= 3) {
        metadata = {
          eventId: parts[1],
          votesBought: Number(parts[2]), // quantity
        }
      }
    }

    const eventId = String(metadata.eventId || '').trim();
    const contestantId = String(metadata.contestantId || '').trim();
    const votesBought = Number(metadata.votesBought || 0);

    if (!eventId ||!votesBought || votesBought < 1) {
      return res.status(400).json({ status: false, message: 'Payment verified, but vote/ticket details are missing' });
    }

    const result = await db.runTransaction(async (transaction) => {
      const paymentRef = db.collection('votePayments').doc(reference);
      const eventRef = db.collection('events').doc(eventId);
      const contestantRef = contestantId? db.collection('eventContestants').doc(contestantId) : null;

      const [paymentSnap, eventSnap, contestantSnap] = await Promise.all([
        transaction.get(paymentRef),
        transaction.get(eventRef),
        contestantRef? transaction.get(contestantRef) : Promise.resolve(null),
      ]);

      if (paymentSnap.exists) {
        const existing = paymentSnap.data() || {};
        return {
          alreadyProcessed: true,
          eventId: existing.eventId || eventId,
          eventName: existing.eventName || metadata.eventName || '',
          contestantName: existing.contestantName || metadata.contestantName || '',
          votesBought: Number(existing.votesBought || votesBought),
        };
      }

      if (!eventSnap.exists) throw new Error('Event not found');
      if (contestantId &&!contestantSnap.exists) throw new Error('Contestant not found');

      const eventData = eventSnap.data() || {};
      const contestantData = contestantSnap?.data() || {};

      let votePrice = Number(eventData.votePrice || metadata.votePrice || 1);
      if (isNaN(votePrice) || votePrice < 1) votePrice = 1;

      const expectedAmount = Number((votesBought * votePrice).toFixed(2)); // GHS
      const paidAmount = Number(paymentData.amount || paymentData.totalAmount || 0);

      if (paidAmount < expectedAmount) {
        throw new Error(`Paid amount GHS ${paidAmount} is lower than expected GHS ${expectedAmount}`);
      }

      // Common fields
      const safeEventName = metadata.eventName || eventData.eventName || '';
      const safeContestantName = metadata.contestantName || contestantData.fullName || '';

      // Save payment
      transaction.set(paymentRef, {
        reference,
        clientReference,
        eventId,
        contestantId: contestantId || null,
        votesBought,
        votePrice,
        amount: paidAmount,
        expectedAmount,
        currency: paymentData.currency || 'GHS',
        status: 'paid',
        paidAt: paymentData.paidAt || admin.firestore.FieldValue.serverTimestamp(),
        channel: paymentData.channel || '',
        customerPhone: paymentData.customerPhoneNumber || '',
        source: metadata.source || 'verify_endpoint',
        processedBy: 'vercel_verify_payment',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // If it's a vote, increment contestant
      if (type === 'vote' && contestantRef) {
        transaction.update(contestantRef, {
          votes: admin.firestore.FieldValue.increment(votesBought),
          totalAmount: admin.firestore.FieldValue.increment(paidAmount),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Always increment event total
      transaction.update(eventRef, {
        totalVotes: admin.firestore.FieldValue.increment(votesBought),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        alreadyProcessed: false,
        eventId,
        eventName: safeEventName,
        contestantName: safeContestantName,
        votesBought,
      };
    });

    res.status(200).json({
      status: true,
      message: result.alreadyProcessed
       ? 'Payment already processed'
        : 'Payment verified and votes added',
      alreadyProcessed: result.alreadyProcessed,
      data: result,
    });

  } catch (error) {
    console.error('Verify payment error:', error);
    res.status(500).json({ status: false, message: error.message || 'Payment verification failed' });
  }
}