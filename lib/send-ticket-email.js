const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Lumina Tickets <tickets@luminacreative.online>';

function formatDate(value) {
  if (!value) return 'TBA';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });
}

// Called once from api/hubtel-callback.js right after a ticket purchase is
// credited. Silently no-ops if RESEND_API_KEY isn't set yet or there's no
// buyer email on file, so ticket crediting itself never depends on email
// actually being configured.
export async function sendTicketEmail({ toEmail, eventName, eventDate, location, ticketTypeName, ticketIds, siteUrl }) {
  if (!RESEND_API_KEY) {
    console.log('RESEND_API_KEY not set — skipping ticket email to', toEmail);
    return { skipped: true, reason: 'no_api_key' };
  }
  if (!toEmail) {
    console.log('No buyer email on file — skipping ticket email');
    return { skipped: true, reason: 'no_email' };
  }
  if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
    console.log('No ticket ids to email');
    return { skipped: true, reason: 'no_tickets' };
  }

  const ticketBlocks = ticketIds.map((id, index) => {
    const statusUrl = `${siteUrl}/ticket-status.html?code=${id}`;
    const qrImgUrl = `${siteUrl}/api/ticket-qr?code=${id}`;
    return `
      <div style="margin:20px 0;padding:16px;border:1px solid #eee4d3;border-radius:12px;text-align:center;">
        <p style="margin:0 0 10px;font-weight:bold;font-family:Arial,Helvetica,sans-serif;">Ticket ${index + 1} of ${ticketIds.length}</p>
        <img src="${qrImgUrl}" width="200" height="200" alt="Ticket QR code" style="display:block;margin:0 auto;" />
        <p style="margin:10px 0 0;font-size:12px;color:#6b6156;font-family:Arial,Helvetica,sans-serif;">
          Show this at the door, or check its status any time:<br>
          <a href="${statusUrl}">${statusUrl}</a>
        </p>
      </div>
    `;
  }).join('');

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#161311;">
      <h2 style="margin:0 0 4px;">${eventName || 'Your Event'}</h2>
      <p style="color:#6b6156;margin:0 0 20px;">${ticketTypeName || 'Regular Ticket'} &middot; ${ticketIds.length} ticket(s)</p>
      <p style="margin:0 0 4px;"><b>Date:</b> ${formatDate(eventDate)}</p>
      <p style="margin:0 0 20px;"><b>Location:</b> ${location || 'TBA'}</p>
      ${ticketBlocks}
      <p style="color:#a99a80;font-size:12px;margin-top:24px;">Lumina Creative Co</p>
    </div>
  `;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: toEmail,
      subject: `Your ticket${ticketIds.length > 1 ? 's' : ''} for ${eventName || 'your event'}`,
      html,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('Resend email send failed:', response.status, text);
    return { skipped: false, ok: false, error: text };
  }

  return { skipped: false, ok: true };
}
