import admin from 'firebase-admin';

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
    const data = req.body;
    console.log('Hubtel callback:', data);
    
    if(data.Status === 'Success'){
      const clientRef = data.ClientReference; // vote_eventId_contestantId_votes_timestamp
      const parts = clientRef.split('_');
      const eventId = parts[1];
      const contestantId = parts[2];
      const votes = parseInt(parts[3]);
      const amount = data.Amount;
      
      // 1. Prevent duplicate
      const existing = await db.collection('votes').doc(clientRef).get();
      if(existing.exists){
        return res.status(200).json({ status: 'already_saved' });
      }

      // 2. Save vote
      await db.collection('votes').doc(clientRef).set({
        eventId,
        contestantId,
        votes,
        amount,
        phoneNumber: data.CustomerMsisdn || 'N/A',
        transactionId: data.TransactionId,
        status: 'paid',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // 3. Increase contestant votes
      await db.collection('eventContestants').doc(contestantId).update({
        votes: admin.firestore.FieldValue.increment(votes)
      });

      console.log('Vote saved for:', contestantId);
    }
    
    res.status(200).json({ status: 'received' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}