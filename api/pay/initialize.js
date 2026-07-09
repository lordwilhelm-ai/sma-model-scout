import admin from 'firebase-admin';
const fetch = globalThis.fetch;

// Initialize Firebase
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
  );
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

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

function formatPhone(phone) {
  if (!phone) return '';
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('0')) p = '233' + p.substring(1);
  if (!p.startsWith('233')) p = '233' + p;
  return p;
}

// Hubtel requires clientReference to be non-empty and <= 32 characters.
// Firestore doc IDs (20 chars) don't fit if embedded directly in the string,
// so we generate a short random reference instead and store the real
// event/contestant/votes details server-side, keyed by that reference.
function shortRef(prefix) {
  const rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `${prefix}_${rand}`.slice(0, 32);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { phone, amount, metadata, eventId, contestantId, contestantName, votes } = req.body || {};

    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ message: 'Valid amount is required' });
    }

    const clientId = process.env.HUBTEL_CLIENT_ID;
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.status(500).json({ message: 'HUBTEL_CLIENT_ID or HUBTEL_CLIENT_SECRET missing' });
    }

    const siteUrl = getSiteUrl(req);
    const callbackUrl = process.env.HUBTEL_CALLBACK_URL || `${siteUrl}/api/hubtel-callback`;
    const returnUrl = process.env.HUBTEL_RETURN_URL || `${siteUrl}/success.html`;
    const cancellationUrl = process.env.HUBTEL_CANCELLATION_URL || `${siteUrl}/voting-home.html`;
    const merchantAccountNumber = String(process.env.HUBTEL_MERCHANT_ACCOUNT || '').trim();

    if (!merchantAccountNumber) {
      return res.status(500).json({ message: 'HUBTEL_MERCHANT_ACCOUNT missing' });
    }

    const formattedPhone = formatPhone(phone);
    const totalAmount = Number(Number(amount).toFixed(2));

    // Vote checkouts pass eventId + contestantId; anything else falls back
    // to the old generic metadata.reference behavior (also capped at 32 chars).
    const isVote = !!(eventId && contestantId);
    const clientReference = isVote
      ? shortRef('vote')
      : (metadata?.reference ? String(metadata.reference).slice(0, 32) : shortRef('pay'));

    const payload = {
      totalAmount,
      description: metadata?.description || (isVote ? `Vote for ${contestantName || contestantId}` : 'Model Scout Vote Payment'),
      callbackUrl,
      returnUrl,
      cancellationUrl,
      merchantAccountNumber,
      clientReference,
      ...(formattedPhone ? { payeeMobileNumber: formattedPhone } : {}),
      ...((metadata?.name || contestantName) ? { payeeName: String(metadata?.name || contestantName) } : {}),
    };

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await fetch('https://payproxyapi.hubtel.com/items/initiate', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + auth,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (err) {
      console.error('Hubtel init parse error', err, 'text:', text);
      return res.status(500).json({ message: 'Invalid response from Hubtel', raw: text });
    }

    if (!response.ok) {
      const message = data?.message || data?.description || 'Hubtel initialization failed';
      const debug = { status: response.status, raw: data };
      if (response.status === 401) {
        debug.note = 'Unauthorized. Verify HUBTEL_CLIENT_ID, HUBTEL_CLIENT_SECRET, and Merchant Account API access.';
      }
      if (response.status === 400) {
        debug.note = 'Validation error. Check amount, merchantAccountNumber, clientReference length (max 32 chars), and required fields.';
      }
      return res.status(response.status).json({ message, ...debug });
    }

    const checkoutUrl = data?.data?.checkoutUrl || data?.checkoutUrl;

    if (!checkoutUrl) {
      return res.status(500).json({ raw: data, message: 'No checkoutUrl in Hubtel response' });
    }

    // Only after Hubtel accepts the request do we persist the pending record,
    // keyed by the exact clientReference the callback will receive.
    if (isVote) {
      await db.collection('pending_payments').doc(clientReference).set({
        type: 'vote',
        source: 'web',
        eventId,
        contestantId,
        contestantName: contestantName || null,
        votes: Number(votes) || null,
        amount: totalAmount,
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return res.status(200).json({
      success: true,
      checkoutUrl: checkoutUrl.trim(),
      checkoutId: data?.data?.checkoutId,
      clientReference: data?.data?.clientReference || clientReference,
      raw: data
    });

  } catch (error) {
    console.error('pay/initialize error:', error);
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
}
