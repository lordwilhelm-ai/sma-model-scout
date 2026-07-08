const fetch = globalThis.fetch;

(async () => {
  try {
    const res = await fetch('https://luminacreative.online/api/pay/initialize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: 100,
        metadata: { description: 'Test payment', reference: 'verify-live-003' }
      })
    });

    console.log('status', res.status);
    console.log(await res.text());
  } catch (e) {
    console.error('error', e);
  }
})();
