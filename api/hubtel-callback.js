import { createClient } from '@supabase/supabase-js';
import { sendTicketEmail } from '../lib/send-ticket-email.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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

    // Fire the ticket QR email off the back of a fresh 'ticket' credit only —
    // "already_saved" means this is a Hubtel retry of a callback we already
    // processed (and already emailed for), so don't send a second email.
    if (type === 'ticket' && data?.status === 'ok' && Array.isArray(data.ticket_ids) && data.ticket_ids.length) {
      try {
        await sendTicketEmail({
          toEmail: data.buyer_email,
          eventName: data.event_name,
          eventDate: data.event_date,
          location: data.location,
          ticketTypeName: data.ticket_type_name,
          ticketIds: data.ticket_ids,
          siteUrl: getSiteUrl(req),
        });
      } catch (emailError) {
        // Never let an email failure affect the (already-committed) payment credit.
        console.error('sendTicketEmail failed:', emailError);
      }
    }

    // Must respond 200 OK so Hubtel stops retrying, regardless of outcome.
    res.status(200).json({ status: data?.status === 'ok' ? 'success' : data?.status, message: data?.message });

  } catch (err) {
    console.error('Callback error:', err);
    res.status(200).json({ status: 'error_logged', message: err.message });
  }
}
