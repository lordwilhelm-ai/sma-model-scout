import admin from 'firebase-admin';
import fetch from 'node-fetch';

// Initialize Firebase
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
  );
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

export default async function handler(req, res) {
  try {
    if (req.method!== 'POST') return res.status(405).end();
    
    const { sessionId, serviceCode, phoneNumber, text } = req.body;
    let response = '';

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
        phoneNumber, contestantCode, amount, status: 'pending', createdAt: new Date()
      });

      // Call Hubtel to charge MoMo
      const auth = Buffer.from(`${process.env.HUBTEL_CLIENT_ID}:${process.env.HUBTEL_CLIENT_SECRET}`).toString('base64');
      await fetch('https://api.hubtel.com/items/v1/receive/mobilemoney', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          CustomerPhoneNumber: phoneNumber,
          CustomerName: 'Lumina Voter',
          Amount: amount,
          Description: `Vote for ${contestantCode}`,
          MerchantAccountNumber: process.env.HUBTEL_MERCHANT_ACCOUNT_NUMBER,
          CallbackUrl: process.env.HUBTEL_CALLBACK_URL,
          CancellationUrl: process.env.HUBTEL_CANCELLATION_URL
        })
      });

      response = `END You will receive a MoMo prompt to approve GHS ${amount}.00`;
    } 
    else {
      response = `END Invalid option`;
    }

    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send(response);

  } catch (err) {
    console.error(err);
    res.setHeader('Content-Type', 'text/plain');
    res.status(500).send(`END Error: ${err.message}`);
  }
}