import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// payment_transactions has no public RLS policy (by design — it's the
// payment ledger), so lookups go through this service-role endpoint instead
// of the browser querying Supabase directly. Only returns rows matching the
// exact reference or phone number given, never a full listing.

function formatPhone(phone) {
  let p = String(phone || '').replace(/\D/g, '');
  if (!p) return '';
  if (p.startsWith('0')) p = '233' + p.substring(1);
  if (!p.startsWith('233')) p = '233' + p;
  return p;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ status: false, message: 'Method not allowed' });
  }

  const reference = String(req.query.reference || '').trim();
  const rawPhone = String(req.query.phone || '').trim();

  if (!reference && !rawPhone) {
    return res.status(400).json({ status: false, message: 'Enter a phone number or payment reference.' });
  }

  try {
    let query = supabase
      .from('payment_transactions')
      .select('*')
      .in('type', ['vote', 'ussd_vote'])
      .order('created_at', { ascending: false })
      .limit(20);

    if (reference) {
      query = supabase
        .from('payment_transactions')
        .select('*')
        .eq('client_reference', reference)
        .in('type', ['vote', 'ussd_vote']);
    } else {
      query = query.eq('phone_number', formatPhone(rawPhone));
    }

    const { data: payments, error } = await query;
    if (error) throw error;

    if (!payments || payments.length === 0) {
      return res.status(200).json({
        status: true,
        data: [],
        message: 'No matching vote payment found yet. If you just paid, wait a moment and check again — confirmations can take up to a minute.'
      });
    }

    const contestantIds = [...new Set(payments.map(p => p.contestant_id).filter(Boolean))];
    const eventIds = [...new Set(payments.map(p => p.event_id).filter(Boolean))];

    const [{ data: contestants }, { data: events }] = await Promise.all([
      contestantIds.length
        ? supabase.from('event_contestants').select('id, full_name, contestant_number, category_name').in('id', contestantIds)
        : Promise.resolve({ data: [] }),
      eventIds.length
        ? supabase.from('events').select('id, event_name').in('id', eventIds)
        : Promise.resolve({ data: [] })
    ]);

    const contestantMap = new Map((contestants || []).map(c => [c.id, c]));
    const eventMap = new Map((events || []).map(e => [e.id, e]));

    const results = payments.map(p => {
      const contestant = contestantMap.get(p.contestant_id);
      const event = eventMap.get(p.event_id);

      return {
        reference: p.client_reference,
        status: p.status,
        source: p.source,
        votes: p.votes || 0,
        amount: p.amount,
        createdAt: p.created_at,
        eventName: event?.event_name || '',
        contestantName: contestant?.full_name || '',
        contestantNumber: contestant?.contestant_number || '',
        categoryName: contestant?.category_name || ''
      };
    });

    res.status(200).json({ status: true, data: results });

  } catch (error) {
    console.error('verify-vote error:', error);
    res.status(500).json({ status: false, message: error.message || 'Could not check vote status right now.' });
  }
}
