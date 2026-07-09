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

function formatPhone(phone) {
  // Convert 0551234567 or +233551234567 to 233551234567
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('0')) p = '233' + p.substring(1);
  if (p.startsWith('233')) return p;
  return '233' + p; // fallback
}

export default async function handler(req, res) {
  try {
    if (req.method!== 'POST') return res.status(405).end();

    const { sessionId, serviceCode, phoneNumber, text } = req.body;
    let response = '';

    const clientId = process.env.HUBTEL_CLIENT_ID;
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET;
    const merchantAccountNumber = String(process.env.HUBTEL_MERCHANT_ACCOUNT || '').trim(); // FIX 1
    const callbackUrl = process.env.HUBTEL_CALLBACK_URL;

    if (!clientId ||!clientSecret ||!merchantAccountNumber) {
      console.error('Missing Hubtel env vars');
      response = `END System error. Please try later.`;
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(response);
    }

    if (text === '') {
      response = `CON Welcome to Lumina Vote\n1. Vote Now\n2. Check Results`;
    }
    else if (text === '1') {
      response = `CON Enter Contestant Code:`;
    }
    else if (text.split('*').length === 2) {
      response = `CON Enter amount:\n1. GHS 1\n2. GHS 5\n3. GHS 10`;
    }
    else if (text.split('*').length === 3) {
      const parts = text.split('*');
      const contestantCode = parts[1];
      const amountChoice = parts[2];
      const amount = amountChoice === '1'? 1 : amountChoice === '2'? 5 : 10;

      // Save pending vote to Firebase
      await db.collection('pending_votes').doc(sessionId).set({
        phoneNumber,
        contestantCode,
        amount,
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Call Hubtel to charge MoMo
      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

      const hubtelPayload = {
        CustomerPhoneNumber: formatPhone(phoneNumber), // FIX 3: 233XXXXXXXXX
        CustomerName: 'Lumina Voter',
        Amount: Number(amount.toFixed(2)),
        Description: `Vote for ${contestantCode}`,
        MerchantAccountNumber: merchantAccountNumber, // FIX 1
        CallbackUrl: callbackUrl,
        ClientReference: `ussd_vote_${sessionId}`
      };

      const hubtelRes = await fetch('https://payproxyapi.hubtel.com/items/v1/receive/mobilemoney', { // FIX 2
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(hubtelPayload)
      });

      const hubtelText = await hubtelRes.text();
      let hubtelData = null;
      try { hubtelData = JSON.parse(hubtelText) } catch(e) { console.error(hubtelText) }

      if (!hubtelRes.ok) {
        console.error('Hubtel USSD error:', hubtelData);
        response = `END Payment failed. Please try again.`;
      } else {
        response = `END You will receive a MoMo prompt on ${formatPhone(phoneNumber)} to approve GHS ${amount}.00`;
      }
    }
    else {
      response = `END Invalid option`;
    }

    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send(response);

  } catch (err) {
    console.error('USSD error:', err);
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send(`END System error. Please try again.`);
  }
}