"use strict";

// Contract test: the published JSON Schema and the server's validator must agree on every example.
// If someone changes one without the other, this fails.

const test = require("node:test");
const assert = require("node:assert/strict");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const { validateCreateParcel } = require("../../src/validate");

const ajv = addFormats(new Ajv2020({ allErrors: true, strict: true }));
const requestSchema = ajv.compile(require("../../schemas/v1/create-parcel.request.schema.json"));
const parcelSchema = ajv.compile(require("../../schemas/v1/parcel.response.schema.json"));
const problemSchema = ajv.compile(require("../../schemas/v1/problem.response.schema.json"));

const examples = [
  { ref: "JD55122", lockerId: "LK-2041", size: "M" },
  { ref: "JD55120", lockerId: "LK-1187 ", size: "M" },
  { ref: " JD1", lockerId: "LK-1", size: "medium" },
  { ref: "JD1", lockerId: "LK-1", size: "large", extra: true },
  { ref: "JD1", lockerId: "LK-1", size: "XL" },
  { ref: "JD1", lockerId: "LK-1", size: "m" },
  { ref: "JD1", lockerId: "LK-1" },
  { ref: "", lockerId: "LK-1", size: "S" },
  { ref: "   ", lockerId: "LK-1", size: "S" },
  { ref: "JD/1", lockerId: "LK-1", size: "S" },
  { ref: "-JD1", lockerId: "LK-1", size: "S" },
  { ref: "x".repeat(64), lockerId: "LK-1", size: "S" },
  { ref: "x".repeat(65), lockerId: "LK-1", size: "S" },
  { ref: 55122, lockerId: "LK-1", size: "S" },
  { ref: "JD1", lockerId: null, size: "S" },
  { ref: "JD1", lockerId: "LK 1", size: "S" },
];

test("request schema and server validator agree on every example", () => {
  for (const body of examples) {
    assert.equal(requestSchema(body), validateCreateParcel(body).ok, `disagreement on ${JSON.stringify(body)}`);
  }
});

test("response schemas accept the documented shapes", () => {
  assert.ok(
    parcelSchema({
      id: "p_3f9c2ab41d0e7788",
      partner: "jd",
      ref: "JD55122",
      lockerId: "LK-2041",
      size: "M",
      status: "created",
      createdAt: "2026-11-04T09:12:15.000Z",
    }),
  );
  assert.equal(parcelSchema({ ok: true, data: { id: "p_1" } }), false, "the draft's {ok,data} envelope would break v1 clients");
  assert.ok(
    problemSchema({
      type: "https://api.ktsm.example/problems/locker-offline",
      title: "Locker offline",
      status: 409,
      code: "LOCKER_OFFLINE",
      retryable: true,
      requestId: "abc",
    }),
  );
});
