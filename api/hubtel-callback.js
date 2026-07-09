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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body;
    console.log('Hubtel callback:', JSON.stringify(payload));

    // Hubtel sends: { ResponseCode, Status, Data: {...} }
    const { ResponseCode, Status, Data } = payload;

    // 1. Only process successful payments
    if (ResponseCode !== '0000' || Status !== 'Success') {
      console.log('Payment not successful:', Status, ResponseCode);
      return res.status(200).json({ status: 'ignored_not_success' });
    }

    const {
      ClientReference,
      CheckoutId,
      SalesInvoiceId,
      Amount,
      CustomerPhoneNumber,
      PaymentDetails,
      Description
    } = Data;

    if (!ClientReference) {
      console.error('No ClientReference in callback');
      return res.status(200).json({ error: 'Missing ClientReference' });
    }

    // 2. Prevent duplicate processing
    const voteDoc = await db.collection('votes').doc(ClientReference).get();
    const ticketDoc = await db.collection('ticket_orders').doc(ClientReference).get();

    if (voteDoc.exists || ticketDoc.exists) {
      console.log('Duplicate callback for:', ClientReference);
      return res.status(200).json({ status: 'already_saved' });
    }

    // 3. Determine type from ClientReference.
    // NOTE: don't rely on split('_')[0] alone — "ussd_vote_sessionId" splits
    // to ["ussd","vote","sessionId"], so parts[0] is "ussd", not "ussd_vote".
    // Match on the actual prefix instead.
    const parts = ClientReference.split('_');
    let type;
    if (ClientReference.startsWith('ussd_vote_')) {
      type = 'ussd_vote';
    } else if (ClientReference.startsWith('vote_')) {
      type = 'vote';
    } else if (ClientReference.startsWith('ticket_')) {
      type = 'ticket';
    } else {
      type = parts[0];
    }

    await db.runTransaction(async (transaction) => {
      if (type === 'vote') {
        // Reference is a short random string (e.g. "vote_ab12cd34"), not
        // eventId/contestantId/votes embedded directly — those are looked
        // up from the pending_payments doc created in pay/initialize.js.
        const pendingRef = db.collection('pending_payments').doc(ClientReference);

        // Reads before writes
        const pendingSnap = await transaction.get(pendingRef);
        if (!pendingSnap.exists) throw new Error('No pending payment found for reference: ' + ClientReference);
        const pendingData = pendingSnap.data();

        const { eventId, contestantId } = pendingData;
        if (!eventId || !contestantId) throw new Error('Pending payment missing eventId/contestantId');

        const voteRef = db.collection('votes').doc(ClientReference);
        const contestantRef = db.collection('eventContestants').doc(contestantId);
        const eventRef = db.collection('events').doc(eventId);

        const eventSnap = await transaction.get(eventRef);
        if (!eventSnap.exists) throw new Error('Event not found: ' + eventId);

        let votePrice = Number(eventSnap.data().votePrice || 1);
        if (isNaN(votePrice) || votePrice < 1) votePrice = 1;

        // Trust the amount Hubtel confirms was paid, never a number supplied
        // by the client.
        const votes = Math.floor(Amount / votePrice);
        if (votes < 1) throw new Error('Confirmed amount too small to credit any votes');

        transaction.set(voteRef, {
          type: 'vote',
          source: 'web',
          eventId,
          contestantId,
          votes,
          amount: Amount,
          votePriceUsed: votePrice,
          phoneNumber: CustomerPhoneNumber || PaymentDetails?.MobileMoneyNumber || 'N/A',
          paymentMethod: PaymentDetails?.PaymentType || 'unknown',
          channel: PaymentDetails?.Channel || 'unknown',
          checkoutId: CheckoutId,
          salesInvoiceId: SalesInvoiceId,
          transactionId: SalesInvoiceId,
          description: Description,
          status: 'paid',
          callbackReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        transaction.update(contestantRef, {
          votes: admin.firestore.FieldValue.increment(votes),
          totalAmount: admin.firestore.FieldValue.increment(Amount)
        });

        transaction.delete(pendingRef);

        console.log(`Web Vote saved: ${votes} votes for ${contestantId} (Amount: ${Amount}, votePrice: ${votePrice})`);

      } else if (type === 'ussd_vote') {
        // Format: ussd_vote_sessionId
        if (parts.length < 3) throw new Error('Invalid ussd_vote ClientReference format');

        const sessionId = parts.slice(2).join('_');
        const pendingRef = db.collection('pending_votes').doc(sessionId);

        // Reads before writes
        const pendingSnap = await transaction.get(pendingRef);
        if (!pendingSnap.exists) throw new Error('No pending USSD vote found for session: ' + sessionId);
        const pendingData = pendingSnap.data();

        const { contestantCode, phoneNumber } = pendingData;

        // contestantCode is used directly as contestantId here — adjust if your
        // system maps codes to IDs differently.
        const contestantId = contestantCode;

        const contestantRef = db.collection('eventContestants').doc(contestantId);
        const contestantSnap = await transaction.get(contestantRef);
        if (!contestantSnap.exists) throw new Error('Contestant not found: ' + contestantId);

        const eventId = contestantSnap.data().eventId;
        let votePrice = 1;
        if (eventId) {
          const eventSnap = await transaction.get(db.collection('events').doc(eventId));
          if (eventSnap.exists) {
            votePrice = Number(eventSnap.data().votePrice || 1);
            if (isNaN(votePrice) || votePrice < 1) votePrice = 1;
          }
        }

        // Trust Hubtel's confirmed Amount over the amount stashed in pending_votes.
        const votes = Math.floor(Amount / votePrice);
        if (votes < 1) throw new Error('Confirmed amount too small to credit any votes');

        const voteRef = db.collection('votes').doc(ClientReference);

        transaction.set(voteRef, {
          type: 'vote',
          source: 'ussd',
          sessionId,
          eventId: eventId || null,
          contestantId,
          votes,
          amount: Amount,
          votePriceUsed: votePrice,
          phoneNumber: CustomerPhoneNumber || phoneNumber,
          paymentMethod: PaymentDetails?.PaymentType || 'MobileMoney',
          channel: PaymentDetails?.Channel || 'USSD',
          checkoutId: CheckoutId,
          salesInvoiceId: SalesInvoiceId,
          transactionId: SalesInvoiceId,
          description: Description,
          status: 'paid',
          callbackReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        transaction.update(contestantRef, {
          votes: admin.firestore.FieldValue.increment(votes),
          totalAmount: admin.firestore.FieldValue.increment(Amount)
        });

        transaction.delete(pendingRef);

        console.log(`USSD Vote saved: ${votes} votes for ${contestantId} from ${phoneNumber} (Amount: ${Amount}, votePrice: ${votePrice})`);

      } else if (type === 'ticket') {
        // Format: ticket_eventId_quantity_timestamp
        if (parts.length < 3) throw new Error('Invalid ticket ClientReference format');

        const eventId = parts[1];

        const ticketRef = db.collection('ticket_orders').doc(ClientReference);
        const eventRef = db.collection('events').doc(eventId);
        const pendingRef = db.collection('pending_ticket_orders').doc(ClientReference);

        // Reads before writes
        const pendingSnap = await transaction.get(pendingRef);
        const pendingData = pendingSnap.exists ? pendingSnap.data() : {};

        let ticketPrice = Number(pendingData.ticketPrice || 0);
        if (isNaN(ticketPrice) || ticketPrice < 1) ticketPrice = 1;

        // Trust Hubtel's confirmed Amount over the quantity embedded in the reference.
        const quantity = Math.floor(Amount / ticketPrice);
        if (quantity < 1) throw new Error('Confirmed amount too small to credit any tickets');

        transaction.set(ticketRef, {
          type: 'ticket',
          eventId,
          email: pendingData.email || 'N/A',
          quantity,
          amount: Amount,
          ticketPrice,
          phoneNumber: CustomerPhoneNumber || PaymentDetails?.MobileMoneyNumber || 'N/A',
          paymentMethod: PaymentDetails?.PaymentType || 'unknown',
          checkoutId: CheckoutId,
          salesInvoiceId: SalesInvoiceId,
          status: 'paid',
          callbackReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        transaction.update(eventRef, {
          ticketsSold: admin.firestore.FieldValue.increment(quantity)
        });

        transaction.delete(pendingRef);

        console.log(`Ticket order saved: ${quantity} tickets for ${eventId} (Amount: ${Amount}, ticketPrice: ${ticketPrice})`);

      } else {
        throw new Error('Unknown ClientReference type: ' + type);
      }
    });

    // 4. Must respond 200 OK so Hubtel stops retrying
    res.status(200).json({ status: 'success' });

  } catch (err) {
    console.error('Callback error:', err);
    res.status(200).json({ status: 'error_logged', message: err.message });
  }
}
