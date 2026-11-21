"use strict";

const crypto = require("node:crypto");
const express = require("express");
const { validateCreateParcel } = require("./validate");
const { createParcelIdempotent } = require("./parcels");
const { sendProblem } = require("./problem");

const TRANSIENT_GRPC = new Set([4, 10, 14]); // DEADLINE_EXCEEDED, ABORTED, UNAVAILABLE

const sha256 = (s) => crypto.createHash("sha256").update(s).digest();

function defaultLog(entry) {
  console.log(JSON.stringify(entry));
}

/**
 * @param {object}  opts
 * @param {object}  opts.db                Firestore instance
 * @param {object}  opts.partnerKeyHashes  { partner: sha256-hex of its API key } (from Secret Manager in prod)
 * @param {string} [opts.authMode]         "enforce" (default) or "report" (log-only, for a non-breaking rollout)
 */
function createApp({ db, partnerKeyHashes, authMode = "enforce", log = defaultLog, newId, now }) {
  const keyIndex = Object.entries(partnerKeyHashes).map(([partner, hex]) => {
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`API key hash for '${partner}' must be 64 hex chars (sha256)`);
    return { partner, hash: Buffer.from(hex, "hex") };
  });
  const app = express();
  app.disable("x-powered-by");

  // Request ID + one structured access log per request. Cloud Logging maps `httpRequest` and `severity`,
  // and the custom fields make "failed or suspicious requests from JD" a precise query (see README).
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.locals.requestId = req.get("x-request-id") || crypto.randomUUID();
    res.set("X-Request-Id", res.locals.requestId);
    res.on("finish", () => {
      const status = res.statusCode;
      log({
        severity: status >= 500 ? "ERROR" : status >= 400 || res.locals.warnings?.length ? "WARNING" : "INFO",
        message: `${req.method} ${req.originalUrl} ${status}`,
        httpRequest: {
          requestMethod: req.method,
          requestUrl: req.originalUrl,
          status,
          latency: `${Number(process.hrtime.bigint() - started) / 1e9}s`,
          userAgent: req.get("user-agent"),
        },
        requestId: res.locals.requestId,
        partner: req.params?.partner ?? res.locals.partner,
        ref: res.locals.ref,
        lockerId: res.locals.lockerId,
        outcome: res.locals.outcome,
        errorCode: res.locals.errorCode,
        warnings: res.locals.warnings,
      });
    });
    next();
  });

  // API-key authentication: the partner comes from the key, never from the URL alone.
  function authenticate(req, res, next) {
    const key = req.get("x-api-key");
    const match = key ? keyIndex.find((k) => crypto.timingSafeEqual(k.hash, sha256(key))) : undefined;
    const pathPartner = req.params.partner;
    res.locals.partner = pathPartner;

    let problem = null;
    if (!match) problem = "UNAUTHENTICATED";
    else if (match.partner !== pathPartner) problem = "FORBIDDEN";

    if (problem && authMode === "enforce") return sendProblem(res, problem);
    if (problem) (res.locals.warnings ??= []).push(`auth would fail: ${problem}`);
    next();
  }

  function requireJson(req, res, next) {
    if (!req.is("application/json")) return sendProblem(res, "UNSUPPORTED_MEDIA_TYPE");
    next();
  }

  app.post(
    "/v1/partners/:partner/parcels",
    authenticate,
    requireJson,
    express.json({ limit: "16kb", strict: false }),
    async (req, res) => {
      const check = validateCreateParcel(req.body);
      res.locals.warnings = [...(res.locals.warnings ?? []), ...check.warnings];
      if (!check.ok) return sendProblem(res, "VALIDATION_FAILED", { errors: check.errors });

      const { ref, lockerId, size } = check.value;
      Object.assign(res.locals, { ref, lockerId });
      const partner = req.params.partner;

      const result = await createParcelIdempotent(db, { partner, ref, lockerId, size }, { newId, now });
      res.locals.outcome = result.outcome;

      switch (result.outcome) {
        case "created":
          return res.status(201).location(`/v1/partners/${partner}/parcels/${result.parcel.id}`).json(result.parcel);
        case "replayed":
          return res.status(200).set("Idempotent-Replayed", "true").json(result.parcel);
        case "conflict":
          return sendProblem(res, "PARCEL_REF_CONFLICT", {
            detail: `ref '${ref}' already identifies parcel ${result.parcel.id} with lockerId '${result.parcel.lockerId}' and size '${result.parcel.size}'.`,
          });
        case "locker_not_found":
          return sendProblem(res, "LOCKER_NOT_FOUND", {
            detail: `Locker '${lockerId}' does not exist.`,
            errors: [{ field: "lockerId", message: "unknown locker" }],
          });
        case "locker_offline":
          return sendProblem(res, "LOCKER_OFFLINE", {
            detail: `Locker '${lockerId}' is ${result.lockerStatus ?? "not online"}; no parcel was created. Retry later or choose another locker.`,
            headers: { "Retry-After": "300" },
          });
        default:
          throw new Error(`unexpected outcome ${result.outcome}`);
      }
    },
  );

  app.use((req, res) => sendProblem(res, "NOT_FOUND"));

  // Express 5 forwards rejected promises here. Never leak stack traces to partners.
  app.use((err, req, res, _next) => {
    if (err.type === "entity.parse.failed") return sendProblem(res, "INVALID_JSON");
    if (err.type === "entity.too.large") return sendProblem(res, "PAYLOAD_TOO_LARGE");
    log({ severity: "ERROR", message: "unhandled error", requestId: res.locals.requestId, error: err.message, stack: err.stack });
    if (TRANSIENT_GRPC.has(err.code)) return sendProblem(res, "UNAVAILABLE", { headers: { "Retry-After": "5" } });
    return sendProblem(res, "INTERNAL");
  });

  return app;
}

module.exports = { createApp };
