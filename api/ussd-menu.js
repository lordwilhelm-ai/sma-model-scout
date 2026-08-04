import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const fetch = globalThis.fetch;

function formatPhone(phone) {
  // Convert 0551234567 or +233551234567 to 233551234567
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('0')) p = '233' + p.substring(1);
  if (p.startsWith('233')) return p;
  return '233' + p; // fallback
}

// Same short-reference scheme as api/pay/initialize.js and
// api/initialize-ticket-payment.js — Hubtel caps ClientReference at 32
// characters, and a Postgres uuid alone (36 chars) already blows past
// that, so we generate a short random key instead and store the real
// event/contestant/ticket details server-side in pending_transactions,
// keyed by it.
function shortRef(prefix) {
  const rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `${prefix}_${rand}`.slice(0, 32);
}

function normalizeStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'active' || s === 'live') return 'active';
  if (s === 'upcoming') return 'upcoming';
  if (s === 'paused') return 'paused';
  return 'closed';
}

async function chargeMomo({ clientId, clientSecret, merchantAccountNumber, callbackUrl, phoneNumber, amount, description, clientReference }) {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const hubtelRes = await fetch('https://payproxyapi.hubtel.com/items/v1/receive/mobilemoney', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      CustomerPhoneNumber: formatPhone(phoneNumber),
      CustomerName: 'Lumina Vote Customer',
      Amount: Number(amount.toFixed(2)),
      Description: description,
      MerchantAccountNumber: merchantAccountNumber,
      CallbackUrl: callbackUrl,
      ClientReference: clientReference
    })
  });

  const hubtelText = await hubtelRes.text();
  let hubtelData = null;
  try { hubtelData = JSON.parse(hubtelText); } catch (e) { console.error(hubtelText); }

  if (!hubtelRes.ok) {
    console.error('Hubtel USSD charge error:', hubtelData);
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).end();

    const { sessionId, phoneNumber, text } = req.body;
    let response = '';

    const clientId = process.env.HUBTEL_CLIENT_ID;
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET;
    const merchantAccountNumber = String(process.env.HUBTEL_MERCHANT_ACCOUNT || '').trim();
    const callbackUrl = process.env.HUBTEL_CALLBACK_URL;

    if (!clientId || !clientSecret || !merchantAccountNumber) {
      console.error('Missing Hubtel env vars');
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send('END System error. Please try later.');
    }

    const parts = text === '' ? [] : text.split('*');

    // ---- Top-level menu ----
    if (parts.length === 0) {
      response = `CON Welcome to Lumina Vote\n1. Vote for a Contestant\n2. Buy Event Ticket`;

    // ================= VOTING =================
    // 1                 -> ask for contestant code
    // 1*CODE            -> show vote-count menu, priced from the event's real vote_price
    // 1*CODE*CHOICE     -> charge
    } else if (parts[0] === '1') {

      if (parts.length === 1) {
        response = `CON Enter Contestant Code:`;

      } else {
        const contestantCode = String(parts[1] || '').trim();

        const { data: contestant, error: contestantError } = await supabase
          .from('event_contestants')
          .select('id, full_name, status, event_id, events(vote_price, status, voting_enabled)')
          .eq('nominee_code', contestantCode)
          .maybeSingle();

        if (contestantError) {
          console.error('USSD contestant lookup error:', contestantError);
          response = `END System error. Please try again.`;
        } else if (!contestant) {
          response = `END Contestant code not found. Please check and try again.`;
        } else if (String(contestant.status || 'active').toLowerCase() !== 'active') {
          response = `END This contestant is not active for voting.`;
        } else if (!contestant.events?.voting_enabled || normalizeStatus(contestant.events?.status) !== 'active') {
          response = `END Voting is not open for this event right now.`;
        } else {
          let votePrice = Number(contestant.events?.vote_price || 1);
          if (isNaN(votePrice) || votePrice < 1) votePrice = 1;

          if (parts.length === 2) {
            response = `CON Vote for ${contestant.full_name}\n` +
              `1. 1 vote (GHS ${votePrice.toFixed(2)})\n` +
              `2. 5 votes (GHS ${(votePrice * 5).toFixed(2)})\n` +
              `3. 10 votes (GHS ${(votePrice * 10).toFixed(2)})`;

          } else {
            const choice = parts[2];
            const votes = choice === '1' ? 1 : choice === '2' ? 5 : choice === '3' ? 10 : 0;

            if (votes === 0) {
              response = `END Invalid option.`;
            } else {
              const amount = Number((votes * votePrice).toFixed(2));

              const { error: pendingError } = await supabase.from('pending_transactions').insert({
                key: sessionId,
                type: 'ussd_vote',
                event_id: contestant.event_id,
                contestant_id: contestant.id,
                phone_number: phoneNumber,
                amount,
                status: 'pending'
              });

              if (pendingError) {
                console.error('pending_transactions insert error:', pendingError);
                response = `END System error. Please try again.`;
              } else {
                const charged = await chargeMomo({
                  clientId, clientSecret, merchantAccountNumber, callbackUrl,
                  phoneNumber, amount,
                  description: `Vote for ${contestant.full_name}`,
                  clientReference: `ussd_vote_${sessionId}`
                });

                response = charged
                  ? `END You will receive a MoMo prompt on ${formatPhone(phoneNumber)} to approve GHS ${amount.toFixed(2)}.`
                  : `END Payment failed. Please try again.`;
              }
            }
          }
        }
      }

    // ================= TICKETS =================
    // 2                     -> ask for event code
    // 2*CODE                -> if the event has named ticket types, list them;
    //                          otherwise ask for quantity directly
    // 2*CODE*TYPE           -> (only when ticket types exist) ask for quantity
    // 2*CODE*QTY            -> (legacy single-type event) charge
    // 2*CODE*TYPE*QTY       -> (multi-type event) charge
    } else if (parts[0] === '2') {

      if (parts.length === 1) {
        response = `CON Enter Event Code:`;

      } else {
        const eventCode = String(parts[1] || '').trim();

        const { data: event, error: eventError } = await supabase
          .from('events')
          .select('id, event_name, status, tickets_enabled, ticket_name, ticket_price, ticket_quantity, tickets_sold')
          .eq('event_code', eventCode)
          .maybeSingle();

        if (eventError) {
          console.error('USSD event lookup error:', eventError);
          response = `END System error. Please try again.`;
        } else if (!event) {
          response = `END Event code not found. Please check and try again.`;
        } else if (!event.tickets_enabled) {
          response = `END Tickets are not available for this event.`;
        } else if (normalizeStatus(event.status) !== 'active') {
          response = `END This event is not open for ticket sales right now.`;
        } else {
          const { data: ticketTypes, error: typesError } = await supabase
            .from('event_ticket_types')
            .select('id, name, price, quantity, sold, status')
            .eq('event_id', event.id)
            .eq('status', 'active')
            .order('created_at', { ascending: true });

          if (typesError) {
            console.error('USSD ticket types lookup error:', typesError);
            response = `END System error. Please try again.`;
          } else {
            const hasTypes = Array.isArray(ticketTypes) && ticketTypes.length > 0;

            if (hasTypes) {
              // ---- Multi ticket-type event ----
              if (parts.length === 2) {
                const lines = ticketTypes.slice(0, 6).map((t, i) => {
                  const available = Math.max(Number(t.quantity || 0) - Number(t.sold || 0), 0);
                  return `${i + 1}. ${t.name || 'Ticket'} - GHS ${Number(t.price || 0).toFixed(2)} (${available} left)`;
                });
                response = `CON ${event.event_name}\n${lines.join('\n')}`;

              } else {
                const typeIndex = parseInt(parts[2], 10) - 1;
                const selectedType = ticketTypes[typeIndex];

                if (!selectedType) {
                  response = `END Invalid ticket type.`;

                } else if (parts.length === 3) {
                  response = `CON Enter number of tickets:`;

                } else {
                  const quantity = parseInt(parts[3], 10);
                  const available = Math.max(Number(selectedType.quantity || 0) - Number(selectedType.sold || 0), 0);

                  if (!quantity || quantity < 1) {
                    response = `END Invalid quantity.`;
                  } else if (quantity > available) {
                    response = `END Only ${available} ${selectedType.name || 'ticket'}(s) left.`;
                  } else {
                    const price = Number(selectedType.price || 1);
                    const amount = Number((quantity * price).toFixed(2));
                    const clientReference = shortRef('ticket');

                    const { error: pendingError } = await supabase.from('pending_transactions').insert({
                      key: clientReference,
                      type: 'ticket',
                      event_id: event.id,
                      ticket_type_id: selectedType.id,
                      phone_number: phoneNumber,
                      ticket_price: price,
                      amount,
                      status: 'pending'
                    });

                    if (pendingError) {
                      console.error('pending_transactions insert error:', pendingError);
                      response = `END System error. Please try again.`;
                    } else {
                      const charged = await chargeMomo({
                        clientId, clientSecret, merchantAccountNumber, callbackUrl,
                        phoneNumber, amount,
                        description: `${quantity}x ${selectedType.name || 'Ticket'} - ${event.event_name}`,
                        clientReference
                      });

                      response = charged
                        ? `END You will receive a MoMo prompt on ${formatPhone(phoneNumber)} to approve GHS ${amount.toFixed(2)}. Check your ticket later at Ticket Status on our site using this phone number.`
                        : `END Payment failed. Please try again.`;
                    }
                  }
                }
              }

            } else {
              // ---- Legacy single ticket type (fields live directly on events) ----
              let ticketPrice = Number(event.ticket_price || 0);
              if (isNaN(ticketPrice) || ticketPrice < 1) ticketPrice = 1;

              const available = Math.max(Number(event.ticket_quantity || 0) - Number(event.tickets_sold || 0), 0);

              if (parts.length === 2) {
                response = `CON ${event.event_name}\nGHS ${ticketPrice.toFixed(2)} per ticket (${available} left)\nEnter number of tickets:`;

              } else {
                const quantity = parseInt(parts[2], 10);

                if (!quantity || quantity < 1) {
                  response = `END Invalid quantity.`;
                } else if (quantity > available) {
                  response = `END Only ${available} ticket(s) left.`;
                } else {
                  const amount = Number((quantity * ticketPrice).toFixed(2));
                  const clientReference = shortRef('ticket');

                  const { error: pendingError } = await supabase.from('pending_transactions').insert({
                    key: clientReference,
                    type: 'ticket',
                    event_id: event.id,
                    ticket_type_id: null,
                    phone_number: phoneNumber,
                    ticket_price: ticketPrice,
                    amount,
                    status: 'pending'
                  });

                  if (pendingError) {
                    console.error('pending_transactions insert error:', pendingError);
                    response = `END System error. Please try again.`;
                  } else {
                    const charged = await chargeMomo({
                      clientId, clientSecret, merchantAccountNumber, callbackUrl,
                      phoneNumber, amount,
                      description: `${quantity}x Ticket - ${event.event_name}`,
                      clientReference
                    });

                    response = charged
                      ? `END You will receive a MoMo prompt on ${formatPhone(phoneNumber)} to approve GHS ${amount.toFixed(2)}. Check your ticket later at Ticket Status on our site using this phone number.`
                      : `END Payment failed. Please try again.`;
                  }
                }
              }
            }
          }
        }
      }

    } else {
      response = `END Invalid option`;
    }

    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send(response);

  } catch (err) {
    console.error('USSD error:', err);
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send(`END System error. Please try again.`);
  }
}
