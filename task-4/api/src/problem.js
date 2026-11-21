"use strict";

// One error format for every failure: RFC 9457 Problem Details (application/problem+json),
// plus stable extension members partners can code against: `code`, `retryable`, `errors`, `requestId`.
const PROBLEMS = Object.freeze({
  INVALID_JSON: { status: 400, title: "Malformed JSON body", retryable: false },
  VALIDATION_FAILED: { status: 400, title: "Request validation failed", retryable: false },
  UNAUTHENTICATED: { status: 401, title: "Missing or invalid API key", retryable: false },
  FORBIDDEN: { status: 403, title: "API key not allowed for this partner", retryable: false },
  NOT_FOUND: { status: 404, title: "No such endpoint", retryable: false },
  PARCEL_REF_CONFLICT: { status: 409, title: "Parcel ref already used with different details", retryable: false },
  LOCKER_OFFLINE: { status: 409, title: "Locker offline", retryable: true },
  PAYLOAD_TOO_LARGE: { status: 413, title: "Request body too large", retryable: false },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: "Content-Type must be application/json", retryable: false },
  LOCKER_NOT_FOUND: { status: 422, title: "Unknown locker", retryable: false },
  INTERNAL: { status: 500, title: "Internal error", retryable: true },
  UNAVAILABLE: { status: 503, title: "Temporarily unavailable", retryable: true },
});

function sendProblem(res, code, { detail, errors, headers } = {}) {
  const p = PROBLEMS[code];
  res.locals.errorCode = code;
  if (headers) res.set(headers);
  res
    .status(p.status)
    .type("application/problem+json")
    .json({
      type: `https://api.ktsm.example/problems/${code.toLowerCase().replaceAll("_", "-")}`,
      title: p.title,
      status: p.status,
      ...(detail ? { detail } : {}),
      code,
      retryable: p.retryable,
      ...(errors ? { errors } : {}),
      requestId: res.locals.requestId,
    });
}

module.exports = { PROBLEMS, sendProblem };
