const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const fetch = require("node-fetch");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

/* ======================
   BASIC HEALTH CHECK
====================== */
app.get("/", (req, res) => {
  res.send("Hubtel voting server running");
});

/* ======================
   CONFIG (frontend keys if needed)
====================== */
app.get("/api/config", (req, res) => {
  res.json({
    hubtelClientId: process.env.HUBTEL_CLIENT_ID || "",
  });
});

/* ======================
   DEBUG HUBTEL KEYS
====================== */
app.get("/api/debug/hubtel", (req, res) => {
  const cid = process.env.HUBTEL_CLIENT_ID || "";
  const secret = process.env.HUBTEL_CLIENT_SECRET || "";

  res.json({
    clientIdStartsWith: cid.slice(0, 10),
    secretStartsWith: secret.slice(0, 10),
    hasClientId: !!cid,
    hasSecret: !!secret,
    port: PORT,
  });
});

/* ======================
   INITIATE PAYMENT (VOTE)
====================== */
app.post("/api/pay/initialize", async (req, res) => {
  try {
    const { phone, amount, metadata } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({
        message: "Phone and amount are required",
      });
    }

    const siteUrl = process.env.HUBTEL_SITE_URL || "https://luminacreative.online";
    const merchantAccountNumber = process.env.HUBTEL_MERCHANT_ACCOUNT_NUMBER || "";

    const payload = {
      totalAmount: amount,
      description: metadata?.description || "Vote Payment",
      callbackUrl: `${siteUrl.replace(/\/$/, "")}/api/hubtel/callback`,
      returnUrl: `${siteUrl.replace(/\/$/, "")}/success.html`,
      cancellationUrl: `${siteUrl.replace(/\/$/, "")}/voting-home.html`,

      customerPhoneNumber: phone,
      clientReference: metadata?.reference || `vote-${Date.now()}`,
      ...(merchantAccountNumber ? { merchantAccountNumber } : {}),
    };

    const response = await fetch(
      "https://payproxyapi.hubtel.com/items/initiate",
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${process.env.HUBTEL_CLIENT_ID}:${process.env.HUBTEL_CLIENT_SECRET}`
            ).toString("base64"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    const data = await response.json();

    console.log("HUBTEL INIT RESPONSE:", JSON.stringify(data, null, 2));

    if (!data.responseCode && data.responseCode !== "0000") {
      return res.status(400).json({
        message: data.description || "Payment initiation failed",
        hubtel: data,
      });
    }

    res.json(data);
  } catch (error) {
    console.error("Hubtel init error:", error);
    res.status(500).json({
      message: "Server error while initializing Hubtel payment",
    });
  }
});

/* ======================
   HUBTEL CALLBACK (REAL VOTE CONFIRMATION)
====================== */
app.post("/api/hubtel/callback", async (req, res) => {
  try {
    const data = req.body;

    console.log("HUBTEL CALLBACK:", JSON.stringify(data, null, 2));

    const status = data?.status || data?.Data?.Status;
    const reference =
      data?.clientReference || data?.Data?.ClientReference;

    // ONLY SUCCESS COUNTS
    if (status === "Success" || status === "Completed") {
      const candidateId = reference?.split("-")[0];

      console.log("VOTE CONFIRMED FOR:", candidateId);

      // 🔥 TODO: connect Supabase here
      // await supabase
      //   .from("candidates")
      //   .update({ votes: votes + 1 })
      //   .eq("id", candidateId);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Callback error:", error);
    res.sendStatus(500);
  }
});

/* ======================
   OPTIONAL: VERIFY PAYMENT (MANUAL CHECK)
====================== */
app.post("/api/pay/verify", async (req, res) => {
  try {
    const { reference } = req.body;

    if (!reference) {
      return res.status(400).json({
        message: "Reference required",
      });
    }

    const response = await fetch(
      `https://api-txnverify.hubtel.com/v1/transactions/${reference}`,
      {
        method: "GET",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${process.env.HUBTEL_CLIENT_ID}:${process.env.HUBTEL_CLIENT_SECRET}`
            ).toString("base64"),
        },
      }
    );

    const data = await response.json();

    console.log("VERIFY RESPONSE:", data);

    res.json(data);
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({
      message: "Verification failed",
    });
  }
});

/* ======================
   START SERVER
====================== */
app.listen(PORT, () => {
  console.log(`Hubtel server running on http://localhost:${PORT}`);
});