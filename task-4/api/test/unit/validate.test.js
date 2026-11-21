"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateCreateParcel } = require("../../src/validate");

test("canonical request is accepted unchanged, no warnings", () => {
  assert.deepEqual(validateCreateParcel({ ref: "JD55122", lockerId: "LK-2041", size: "M" }), {
    ok: true,
    value: { ref: "JD55122", lockerId: "LK-2041", size: "M" },
    warnings: [],
  });
});

test("v1 leniency seen in production: trailing space trimmed, 'medium' normalised, both warned", () => {
  const r = validateCreateParcel({ ref: "JD55120", lockerId: "LK-1187 ", size: "medium" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { ref: "JD55120", lockerId: "LK-1187", size: "M" });
  assert.equal(r.warnings.length, 2);
});

test("unknown fields are ignored with a warning (not a breaking rejection)", () => {
  const r = validateCreateParcel({ ref: "A1", lockerId: "LK-1", size: "S", note: "x" });
  assert.equal(r.ok, true);
  assert.match(r.warnings[0], /unknown field 'note'/);
});

test("field-level errors for missing, wrong type and invalid values; all reported at once", () => {
  const r = validateCreateParcel({ ref: 123, size: "XL" });
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.errors.map((e) => e.field),
    ["ref", "lockerId", "size"],
  );
});

test("non-object bodies are rejected", () => {
  for (const body of [null, [], "x", 42]) assert.equal(validateCreateParcel(body).ok, false);
});
