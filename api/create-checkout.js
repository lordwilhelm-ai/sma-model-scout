import admin from 'firebase-admin';
const fetch = globalThis.fetch;

// Initialize Firebase
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
  );
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { contestantId, contestantName, eventId, amount, votes, phone } = req.body;
    
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    const clientId = process.env.HUBTEL_CLIENT_ID;
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET;
    const merchantAccountNumber = String(process.env.HUBTEL_MERCHANT_ACCOUNT || '').trim(); // FIX 1

    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: 'HUBTEL_CLIENT_ID or HUBTEL_CLIENT_SECRET missing' });
    }
    if (!merchantAccountNumber) {
      return res.status(500).json({ error: 'HUBTEL_MERCHANT_ACCOUNT missing' });
    }

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    
    const siteUrl = process.env.HUBTEL_SITE_URL || `https://${req.headers.host}`;
    const callbackUrl = process.env.HUBTEL_CALLBACK_URL || `${siteUrl}/api/hubtel-callback`;
    const returnUrl = process.env.HUBTEL_RETURN_URL || `${siteUrl}/success.html`;
    const cancellationUrl = process.env.HUBTEL_CANCELLATION_URL || `${siteUrl}/voting-home.html`;

    const clientReference = `vote_${eventId}_${contestantId}_${votes}_${Date.now()}`.slice(0, 32); // Hubtel max 32 chars

    const payload = {
      totalAmount: Number(Number(amount).toFixed(2)), // FIX 2: 2 decimals required
      description: `Vote for ${contestantName} - ${votes} votes`,
      merchantAccountNumber, // FIX 1: correct env name
      callbackUrl,
      returnUrl,
      cancellationUrl,
      clientReference,
      ...(phone ? { payeeMobileNumber: String(phone) } : {}), // FIX 3: Hubtel uses payeeMobileNumber
      payeeName: contestantName,
    };

    const response = await fetch('https://payproxyapi.hubtel.com/items/initiate', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let data = null;

    try {
      data = JSON.parse(text);
    } catch (parseError) {
      console.error('Hubtel response parse error', parseError, 'response text:', text);
      return res.status(500).json({ error: 'Invalid response from Hubtel', raw: text });
    }

    if (!response.ok) {
      const message = data?.message || data?.description || 'Hubtel error';
      const debug = { status: response.status, raw: data };
      if (response.status === 401) {
        debug.note = 'Unauthorized. Verify keys belong to merchant 2039825.';
      }
      if (response.status === 400) {
        debug.note = 'Validation error. Check amount and merchantAccountNumber.';
      }
      return res.status(response.status).json({ error: message, ...debug });
    }

    const checkoutUrl = data?.data?.checkoutUrl || data?.checkoutUrl;

    if (!checkoutUrl) {
      console.error('Unexpected Hubtel response:', data);
      return res.status(500).json({ error: 'No checkout URL returned by Hubtel', raw: data });
    }

    // Optional: Save pending vote to Firestore before redirect
    const db = admin.firestore();
    await db.collection('pending_payments').doc(clientReference).set({
      eventId,
      contestantId,
      contestantName,
      votes,
      amount: Number(amount),
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(200).json({ 
      success: true,
      checkoutUrl,
      checkoutId: data?.data?.checkoutId,
      clientReference
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}