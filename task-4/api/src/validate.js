"use strict";

// Request validation for POST /v1/partners/:partner/parcels.
// Mirrors schemas/v1/create-parcel.request.schema.json exactly (a contract test checks both agree).
//
// v1 is LENIENT where production traffic proves partners already depend on it, and records a warning:
//   - surrounding whitespace in ref/lockerId is trimmed   ("LK-1187 " was sent by JD)
//   - size aliases small/medium/large map to S/M/L         ("medium" was sent by JD and accepted)
//   - unknown fields are ignored, not rejected             (rejecting them could break a live client)
// Everything else is rejected with field-level errors. v2 will be strict (see README).

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SIZES = Object.freeze({ S: "S", M: "M", L: "L", small: "S", medium: "M", large: "L" });
const KNOWN_FIELDS = new Set(["ref", "lockerId", "size"]);

function readId(body, field, errors, warnings) {
  const raw = body[field];
  if (raw === undefined || raw === null) return void errors.push({ field, message: "is required" });
  if (typeof raw !== "string") return void errors.push({ field, message: "must be a string" });
  const value = raw.trim();
  if (!ID_RE.test(value)) {
    return void errors.push({ field, message: "must be 1-64 chars: letters, digits, '.', '_' or '-', starting with a letter or digit" });
  }
  if (value !== raw) warnings.push(`${field} had surrounding whitespace; trimmed (deprecated, rejected in v2)`);
  return value;
}

function validateCreateParcel(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "(body)", message: "must be a JSON object" }], warnings: [] };
  }
  const errors = [];
  const warnings = [];

  const ref = readId(body, "ref", errors, warnings);
  const lockerId = readId(body, "lockerId", errors, warnings);

  let size;
  if (body.size === undefined || body.size === null) errors.push({ field: "size", message: "is required" });
  else if (!Object.hasOwn(SIZES, body.size)) errors.push({ field: "size", message: "must be one of S, M, L" });
  else {
    size = SIZES[body.size];
    if (size !== body.size) warnings.push(`size '${body.size}' is a deprecated alias of '${size}'`);
  }

  for (const key of Object.keys(body)) {
    if (!KNOWN_FIELDS.has(key)) warnings.push(`unknown field '${key}' ignored`);
  }

  return errors.length ? { ok: false, errors, warnings } : { ok: true, value: { ref, lockerId, size }, warnings };
}

module.exports = { validateCreateParcel, SIZES };
