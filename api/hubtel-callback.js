import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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

    // Determine type from ClientReference.
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

    // pending_transactions is keyed by ClientReference for vote/ticket, but
    // by the USSD sessionId for ussd_vote (format: ussd_vote_sessionId).
    const key = type === 'ussd_vote' ? parts.slice(2).join('_') : ClientReference;

    const { data, error } = await supabase.rpc('process_hubtel_payment', {
      p_client_reference: ClientReference,
      p_type: type,
      p_key: key,
      p_amount: Amount,
      p_phone: CustomerPhoneNumber || PaymentDetails?.MobileMoneyNumber || null,
      p_checkout_id: CheckoutId || null,
      p_sales_invoice_id: SalesInvoiceId || null,
      p_transaction_id: SalesInvoiceId || null,
      p_description: Description || null
    });

    if (error) {
      console.error('process_hubtel_payment error:', error);
      return res.status(200).json({ status: 'error_logged', message: error.message });
    }

    console.log('process_hubtel_payment result:', data);

    // Must respond 200 OK so Hubtel stops retrying, regardless of outcome.
    res.status(200).json({ status: data?.status === 'ok' ? 'success' : data?.status, message: data?.message });

  } catch (err) {
    console.error('Callback error:', err);
    res.status(200).json({ status: 'error_logged', message: err.message });
  }
}
