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
  if (req.method!== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { contestantId, contestantName, eventId, amount, votes } = req.body;
    
    const auth = Buffer.from(`${process.env.HUBTEL_CLIENT_ID}:${process.env.HUBTEL_CLIENT_SECRET}`).toString('base64');
    
    const payload = {
      totalAmount: amount,
      description: `Vote for ${contestantName} - ${votes} votes`,
      merchantAccountNumber: process.env.HUBTEL_MERCHANT_ACCOUNT_NUMBER,
      callbackUrl: process.env.HUBTEL_CALLBACK_URL,
      returnUrl: process.env.HUBTEL_RETURN_URL,
      cancellationUrl: process.env.HUBTEL_CANCELLATION_URL,
      clientReference: `vote_${eventId}_${contestantId}_${votes}_${Date.now()}`
    };

    const endpoints = [
      'https://payproxyapi.hubtel.com/items/initiate',
      'https://api.hubtel.com/items/v1/initiate'
    ];

    let response = null;
    let text = '';
    let data = null;

    for (const url of endpoints) {
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        text = await response.text();

        try {
          data = JSON.parse(text);
        } catch (parseError) {
          console.error('Hubtel response parse error for', url, parseError, 'response text:', text);
          data = null;
        }

        if (response.ok && (data?.data?.checkoutUrl || data?.checkoutUrl || data?.paymentUrl || data?.url)) {
          break; // success
        }

      } catch (e) {
        console.error('Error contacting Hubtel at', url, e);
      }
    }

    if(!response){
      return res.status(500).json({ error: 'No response from Hubtel endpoints' });
    }

    if(!response.ok){
      const message = data?.message || data?.description || data?.error || text || 'Hubtel error';
      return res.status(response.status || 500).json({ error: message, raw: text });
    }

    const checkoutUrl = data?.data?.checkoutUrl || data?.checkoutUrl || data?.paymentUrl || data?.url || null;

    if (!checkoutUrl) {
      console.error('Unexpected Hubtel response (no url):', text);
      return res.status(500).json({ error: 'No checkout URL returned by Hubtel', raw: text });
    }

    res.status(200).json({ checkoutUrl });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}