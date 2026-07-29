import QRCode from 'qrcode';

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

// Renders a QR PNG that encodes the public ticket-status page URL for a given
// ticket id — the same image is used on ticket-success.html and inlined in
// the confirmation email, so there's exactly one place QR images are made.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const code = String(req.query.code || '').trim();
  if (!code) {
    return res.status(400).json({ message: 'Missing ticket code' });
  }

  const siteUrl = getSiteUrl(req);
  const statusUrl = `${siteUrl}/ticket-status.html?code=${encodeURIComponent(code)}`;

  try {
    const buffer = await QRCode.toBuffer(statusUrl, { type: 'png', width: 320, margin: 1 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.status(200).send(buffer);
  } catch (error) {
    console.error('QR generation error:', error);
    res.status(500).json({ message: 'Could not generate QR code' });
  }
}
