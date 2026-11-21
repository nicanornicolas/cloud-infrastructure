"use strict";

const { Firestore } = require("@google-cloud/firestore");
const { createApp } = require("./app");

// PARTNER_API_KEY_HASHES='{"jd":"<sha256 hex>","evri":"<sha256 hex>"}', injected from Secret Manager
// (gcloud run deploy --set-secrets=PARTNER_API_KEY_HASHES=partner-api-key-hashes:latest). Only hashes are stored.
const partnerKeyHashes = JSON.parse(process.env.PARTNER_API_KEY_HASHES || "{}");
if (Object.keys(partnerKeyHashes).length === 0) {
  console.error(JSON.stringify({ severity: "CRITICAL", message: "PARTNER_API_KEY_HASHES is empty; refusing to start" }));
  process.exit(1);
}

const app = createApp({
  db: new Firestore(),
  partnerKeyHashes,
  authMode: process.env.AUTH_MODE === "report" ? "report" : "enforce",
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(JSON.stringify({ severity: "INFO", message: `listening on ${port}` })));
