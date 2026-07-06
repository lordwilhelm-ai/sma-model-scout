import fetch from 'node-fetch';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  
  const { sessionId, serviceCode, phoneNumber, text } = req.body;
  let response = '';

  if (text === '') {
    response = `CON Welcome to Lumina Vote\n1. Vote Now\n2. Check Results`;
  } else if (text === '1') {
    response = `CON Enter Contestant Code:`;
  } else if (text.length === 3) {
    response = `CON Enter amount:\n1. GHS 1\n2. GHS 5\n3. GHS 10`;
  } else if (text.split('*').length === 3) {
    const [contestant, amount] = text.split('*').slice(1);
    // Call Hubtel to charge MoMo here
    response = `END You will receive a MoMo prompt to approve GHS ${amount} vote`;
  }

  res.setHeader('Content-Type', 'text/plain');
  res.status(200).send(response);
}