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
    
    const response = await fetch('https://api.hubtel.com/items/v1/initiate', {
      method: 'POST',
      headers: { 
        'Authorization': `Basic ${auth}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({
        totalAmount: amount,
        description: `Vote for ${contestantName} - ${votes} votes`,
        merchantAccountNumber: process.env.HUBTEL_MERCHANT_ACCOUNT_NUMBER,
        callbackUrl: process.env.HUBTEL_CALLBACK_URL,
        returnUrl: process.env.HUBTEL_RETURN_URL,
        cancellationUrl: process.env.HUBTEL_CANCELLATION_URL,
        clientReference: `vote_${eventId}_${contestantId}_${votes}_${Date.now()}`
      })
    });
    
    const text = await response.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch (parseError) {
      console.error('Hubtel response parse error:', parseError, 'response text:', text);
      data = null;
    }
    
    if(!response.ok){
      const message =
        data?.message ||
        data?.description ||
        data?.error ||
        text ||
        'Hubtel error';
      return res.status(500).json({ error: message });
    }

    if (!data || !data.data || !data.data.checkoutUrl) {
      console.error('Unexpected Hubtel response:', text);
      return res.status(500).json({ error: 'No checkout URL returned by Hubtel', raw: text });
    }

    res.status(200).json({ checkoutUrl: data.data.checkoutUrl });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}