**Paystack Integration**

- Copy `server/.env.example` to `server/.env` and set your Paystack `PAYSTACK_SECRET_KEY` and `PAYSTACK_PUBLIC_KEY`.
- Install server dependencies and run the helper server:

```bash
cd server
npm install
npm run start
```

- The frontend will call `/api/pay/initialize` and `/api/pay/verify` on the same origin. If your frontend is served from a different origin, adjust CORS or proxy settings.
- Replace `PAYSTACK_PUBLIC_KEY` placeholder in `vote-checkout.html` with your public key or inject it server-side when serving templates.

Notes:
- The server endpoints in `server/server.js` forward initialization and verification requests to Paystack using the secret key. Keep the secret key private.
- After successful verification the frontend records the vote in Firestore. You may opt to persist pending votes server-side instead depending on your trust model.
