import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Public, read-only. Anyone with a ticket's code/QR can check its status —
// that's the point of a ticket — but this never changes anything, no matter
// how many times it's opened. Only api/checkin-ticket.js can flip it to 'used'.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ status: false, message: 'Method not allowed' });
  }

  const code = String(req.query.code || '').trim();
  if (!code) {
    return res.status(400).json({ status: false, message: 'Missing ticket code' });
  }

  try {
    const { data: ticket, error } = await supabase
      .from('event_tickets')
      .select('*, events(event_name, event_date, location, contact_phone, status), event_ticket_types(name)')
      .eq('id', code)
      .maybeSingle();

    if (error) throw error;
    if (!ticket) {
      return res.status(404).json({ status: false, message: 'Ticket not found' });
    }

    res.status(200).json({
      status: true,
      data: {
        ticketId: ticket.id,
        ticketStatus: ticket.status,
        usedAt: ticket.used_at,
        eventName: ticket.events?.event_name || '',
        eventStatus: ticket.events?.status || '',
        eventDate: ticket.events?.event_date || '',
        location: ticket.events?.location || '',
        contactPhone: ticket.events?.contact_phone || '',
        ticketTypeName: ticket.event_ticket_types?.name || 'Regular Ticket'
      }
    });
  } catch (error) {
    console.error('Ticket status error:', error);
    res.status(500).json({ status: false, message: error.message || 'Could not fetch ticket status' });
  }
}
