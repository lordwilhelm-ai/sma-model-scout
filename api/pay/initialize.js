import fetch from 'node-fetch';

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
  if (req.method !== 'POST') {
    res.status(405).json({ message: 'Method not allowed' });
    return;
  }

  try {
    const { phone, amount, metadata } = req.body || {};

    if (!amount || isNaN(Number(amount))) {
      res.status(400).json({ message: 'Amount is required' });
      return;
    }

    const clientId = process.env.HUBTEL_CLIENT_ID;
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      res.status(500).json({ message: 'HUBTEL_CLIENT_ID or HUBTEL_CLIENT_SECRET missing' });
      return;
    }

    const siteUrl = getSiteUrl(req);
    const callbackUrl = process.env.HUBTEL_CALLBACK_URL || `${siteUrl}/api/hubtel-callback`;
    const returnUrl = process.env.HUBTEL_RETURN_URL || `${siteUrl}/success.html`;
    const cancellationUrl = process.env.HUBTEL_CANCELLATION_URL || `${siteUrl}/voting-home.html`;
    const merchantAccountNumber = String(process.env.HUBTEL_MERCHANT_ACCOUNT_NUMBER || '').trim();

    const payload = {
      totalAmount: Number(amount),
      description: metadata?.description || 'Payment',
      callbackUrl,
      returnUrl,
      cancellationUrl,
      ...(phone ? { customerPhoneNumber: String(phone) } : {}),
      clientReference: metadata?.reference || `pay_${Date.now()}`,
      ...(merchantAccountNumber ? { merchantAccountNumber } : {}),
    };

    const response = await fetch('https://payproxyapi.hubtel.com/items/initiate', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      console.error('Hubtel init parse error:', err, 'text:', text);
      data = null;
    }

    if (!response.ok) {
      const message = data?.message || data?.description || text || 'Hubtel initialization failed';
      res.status(response.status || 500).json({ message, raw: data || text });
      return;
    }

    // Try to extract payment link
    const candidates = [
      data?.paymentUrl,
      data?.payment_url,
      data?.authorizationUrl,
      data?.authorization_url,
      data?.redirectUrl,
      data?.redirect_url,
      data?.url,
      data?.checkoutUrl,
      data?.checkout_url,
      data?.link,
      data?.data?.paymentUrl,
      data?.data?.payment_url,
      data?.data?.authorizationUrl,
      data?.data?.authorization_url,
      data?.data?.redirectUrl,
      data?.data?.redirect_url,
      data?.data?.url,
      data?.data?.checkoutUrl,
      data?.data?.checkout_url,
      data?.data?.link,
    ];

    const checkoutUrl = candidates.find(item => typeof item === 'string' && item.trim());

    if (!checkoutUrl) {
      // Return full response so caller can inspect
      res.status(200).json({ raw: data, message: 'No explicit checkout URL in Hubtel response' });
      return;
    }

    res.status(200).json({ checkoutUrl: checkoutUrl.trim(), raw: data });
  } catch (error) {
    console.error('pay/initialize error:', error);
    res.status(500).json({ message: error.message || 'Internal server error' });
  }
}
