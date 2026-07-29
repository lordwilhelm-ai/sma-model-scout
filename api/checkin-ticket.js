import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// The only place a ticket's status ever changes. Requires a logged-in
// organizer/admin session (Authorization: Bearer <supabase access token>).
// Scanning/viewing a ticket (api/ticket-status.js) never touches this table —
// only this endpoint does, and only once per ticket (the update is guarded
// by status = 'valid' so a second check-in attempt can't double-consume it).
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: false, message: 'Method not allowed' });
  }

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      return res.status(401).json({ status: false, message: 'Missing auth token' });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) {
      return res.status(401).json({ status: false, message: 'Invalid or expired session' });
    }
    const uid = userData.user.id;

    const code = String(req.body?.code || '').trim();
    if (!code) {
      return res.status(400).json({ status: false, message: 'Missing ticket code' });
    }

    const { data: ticket, error: ticketError } = await supabase
      .from('event_tickets')
      .select('*, events(organizer_id, event_name)')
      .eq('id', code)
      .maybeSingle();

    if (ticketError) throw ticketError;
    if (!ticket) {
      return res.status(404).json({ status: false, message: 'Ticket not found. Check the code and try again.' });
    }

    const { data: isAdmin } = await supabase.rpc('is_admin', { uid });
    const isOrganizerOfEvent = ticket.events?.organizer_id === uid;

    if (!isAdmin && !isOrganizerOfEvent) {
      return res.status(403).json({ status: false, message: 'This ticket is not for one of your events.' });
    }

    if (ticket.status === 'used') {
      return res.status(409).json({
        status: false,
        alreadyUsed: true,
        message: 'This ticket was already checked in.',
        data: { eventName: ticket.events?.event_name || '', usedAt: ticket.used_at }
      });
    }

    const { data: updated, error: updateError } = await supabase
      .from('event_tickets')
      .update({ status: 'used', used_at: new Date().toISOString(), used_by: uid })
      .eq('id', code)
      .eq('status', 'valid')
      .select()
      .maybeSingle();

    if (updateError) throw updateError;

    if (!updated) {
      return res.status(409).json({
        status: false,
        alreadyUsed: true,
        message: 'This ticket was just checked in by someone else.'
      });
    }

    res.status(200).json({
      status: true,
      message: 'Checked in successfully.',
      data: { eventName: ticket.events?.event_name || '', ticketId: ticket.id }
    });

  } catch (error) {
    console.error('Check-in error:', error);
    res.status(500).json({ status: false, message: error.message || 'Check-in failed' });
  }
}
