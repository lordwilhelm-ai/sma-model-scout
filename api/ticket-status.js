import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function formatPhone(phone) {
  let p = String(phone || '').replace(/\D/g, '');
  if (!p) return '';
  if (p.startsWith('0')) p = '233' + p.substring(1);
  if (!p.startsWith('233')) p = '233' + p;
  return p;
}

function toTicketSummary(ticket) {
  return {
    ticketId: ticket.id,
    ticketStatus: ticket.status,
    usedAt: ticket.used_at,
    eventName: ticket.events?.event_name || '',
    eventStatus: ticket.events?.status || '',
    eventDate: ticket.events?.event_date || '',
    location: ticket.events?.location || '',
    contactPhone: ticket.events?.contact_phone || '',
    ticketTypeName: ticket.event_ticket_types?.name || 'Regular Ticket'
  };
}

// Public, read-only. Anyone with a ticket's code/QR (or the phone number
// used to buy it — e.g. USSD buyers, who never had a QR emailed to them
// in the first place) can look their ticket(s) up. This never changes
// anything, no matter how many times it's opened — only
// api/checkin-ticket.js can ever flip a ticket to 'used'.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ status: false, message: 'Method not allowed' });
  }

  const code = String(req.query.code || '').trim();
  const phone = String(req.query.phone || '').trim();

  if (!code && !phone) {
    return res.status(400).json({ status: false, message: 'Enter a ticket code or phone number' });
  }

  try {
    if (code) {
      const { data: ticket, error } = await supabase
        .from('event_tickets')
        .select('*, events(event_name, event_date, location, contact_phone, status), event_ticket_types(name)')
        .eq('id', code)
        .maybeSingle();

      if (error) throw error;
      if (!ticket) {
        return res.status(404).json({ status: false, message: 'Ticket not found' });
      }

      return res.status(200).json({ status: true, data: toTicketSummary(ticket) });
    }

    const formattedPhone = formatPhone(phone);

    const { data: tickets, error } = await supabase
      .from('event_tickets')
      .select('*, events(event_name, event_date, location, contact_phone, status), event_ticket_types(name)')
      .eq('buyer_phone', formattedPhone)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;
    if (!tickets || tickets.length === 0) {
      return res.status(404).json({ status: false, message: 'No tickets found for that phone number' });
    }

    res.status(200).json({ status: true, data: tickets.map(toTicketSummary) });

  } catch (error) {
    console.error('Ticket status error:', error);
    res.status(500).json({ status: false, message: error.message || 'Could not fetch ticket status' });
  }
}
