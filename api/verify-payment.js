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
        message: hubtelJson.description || hubtelJson.message || 'Could not verify payment',
        hubtel: hubtelJson,
      });
      return;
    }

    const metadata = extractHubtelMetadata(hubtelJson) || extractHubtelMetadata(paymentData) || {};

    const eventId = String(metadata.eventId || '').trim();
    const contestantId = String(metadata.contestantId || '').trim();
    const votesBought = Number(metadata.votesBought || 0);

    if (!eventId || !contestantId || !votesBought || votesBought < 1) {
      res.status(400).json({ status: false, message: 'Payment verified, but vote details are missing' });
      return;
    }

    const result = await db.runTransaction(async (transaction) => {
      const paymentRef = db.collection('votePayments').doc(reference);
      const eventRef = db.collection('events').doc(eventId);
      const contestantRef = db.collection('eventContestants').doc(contestantId);

      const [paymentSnap, eventSnap, contestantSnap] = await Promise.all([
        transaction.get(paymentRef),
        transaction.get(eventRef),
        transaction.get(contestantRef),
      ]);

      if (paymentSnap.exists) {
        const existing = paymentSnap.data() || {};
        return {
          alreadyProcessed: true,
          eventId: existing.eventId || eventId,
          eventName: existing.eventName || metadata.eventName || '',
          contestantName: existing.contestantName || metadata.contestantName || '',
          contestantNumber: existing.contestantNumber || metadata.contestantNumber || '',
          categoryName: existing.categoryName || metadata.categoryName || '',
          votesBought: Number(existing.votesBought || votesBought),
        };
      }

      if (!eventSnap.exists) {
        throw new Error('Event not found');
      }

      if (!contestantSnap.exists) {
        throw new Error('Contestant not found');
      }

      const eventData = eventSnap.data() || {};
      const contestantData = contestantSnap.data() || {};

      if (String(contestantData.eventId || '') !== eventId) {
        throw new Error('Contestant does not belong to this event');
      }

      let votePrice = Number(eventData.votePrice || metadata.votePrice || 1);
      if (isNaN(votePrice) || votePrice < 1) {
        votePrice = 1;
      }

      const expectedAmount = Math.round(votesBought * votePrice * 100);
      const paidAmount = Number(paymentData.amount || paymentData.totalAmount || paymentData.TotalAmount || paymentData.Amount || 0);

      if (paidAmount < expectedAmount) {
        throw new Error('Paid amount is lower than expected vote amount');
      }

      const safeEventCode =
        metadata.eventCode || eventData.eventCode || contestantData.eventCode || '';
      const safeEventName =
        metadata.eventName || eventData.eventName || contestantData.eventName || '';
      const safeContestantNumber =
        metadata.contestantNumber || contestantData.contestantNumber || '';
      const safeContestantName =
        metadata.contestantName || contestantData.fullName || '';
      const safeCategoryId =
        metadata.categoryId || contestantData.categoryId || '';
      const safeCategoryCode =
        metadata.categoryCode || contestantData.categoryCode || '';
      const safeCategoryName =
        metadata.categoryName || contestantData.categoryName || '';

      transaction.set(paymentRef, {
        reference,
        eventId,
        eventCode: safeEventCode,
        eventName: safeEventName,
        contestantId,
        contestantNumber: safeContestantNumber,
        contestantName: safeContestantName,
        categoryId: safeCategoryId,
        categoryCode: safeCategoryCode,
        categoryName: safeCategoryName,
        votesBought,
        votePrice,
        amount: paidAmount,
        expectedAmount,
        currency: paymentData.currency || paymentData.Currency || 'GHS',
        status: paymentStatus,
        paidAt: paymentData.paidAt || paymentData.PaidAt || paymentData.paid_at || null,
        channel: paymentData.channel || paymentData.Channel || '',
        customerEmail: paymentData.customer?.email || paymentData.CustomerEmail || '',
        source: metadata.source || 'lumina_vote_checkout',
        processedBy: 'vercel_verify_payment',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      transaction.update(contestantRef, {
        votes: admin.firestore.FieldValue.increment(votesBought),
        eventCode: safeEventCode,
        eventName: safeEventName,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      transaction.update(eventRef, {
        totalVotes: admin.firestore.FieldValue.increment(votesBought),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        alreadyProcessed: false,
        eventId,
        eventName: safeEventName,
        contestantName: safeContestantName,
        contestantNumber: safeContestantNumber,
        categoryName: safeCategoryName,
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
