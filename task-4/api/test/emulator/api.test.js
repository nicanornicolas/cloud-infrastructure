"use strict";

// HTTP-level tests of the fixed endpoint against the Firestore emulator. Every response body is also
// validated against the published v1 response schemas.
//   npm run test:emulator   (Java 21+)

const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Firestore } = require("@google-cloud/firestore");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const { createApp } = require("../../src/app");

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-task4";
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const KEYS = { jd: "jd-test-key", evri: "evri-test-key" };

const ajv = addFormats(new Ajv2020({ strict: true }));
const isParcel = ajv.compile(require("../../schemas/v1/parcel.response.schema.json"));
const isProblem = ajv.compile(require("../../schemas/v1/problem.response.schema.json"));

describe("POST /v1/partners/:partner/parcels", { skip: !HOST && "FIRESTORE_EMULATOR_HOST not set" }, () => {
  const db = new Firestore({ projectId: PROJECT });
  const logs = [];
  let server;
  let base;

  before(async () => {
    const app = createApp({
      db,
      partnerKeyHashes: { jd: sha(KEYS.jd), evri: sha(KEYS.evri) },
      log: (e) => logs.push(e),
    });
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  beforeEach(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
    await db.collection("lockers").doc("LK-2041").set({ status: "online" });
    await db.collection("lockers").doc("LK-3000").set({ status: "online" });
    await db.collection("lockers").doc("LK-0933").set({ status: "offline" });
    logs.length = 0;
  });

  async function post(body, { partner = "jd", key = KEYS.jd, contentType = "application/json", raw } = {}) {
    const headers = { "content-type": contentType };
    if (key) headers["x-api-key"] = key;
    const res = await fetch(`${base}/v1/partners/${partner}/parcels`, {
      method: "POST",
      headers,
      body: raw ?? JSON.stringify(body),
    });
    const json = await res.json();
    if (res.ok) assert.ok(isParcel(json), `2xx body violates parcel schema: ${JSON.stringify(json)}`);
    else {
      assert.ok(isProblem(json), `error body violates problem schema: ${JSON.stringify(json)}`);
      assert.match(res.headers.get("content-type"), /application\/problem\+json/);
    }
    return { status: res.status, headers: res.headers, json };
  }

  const parcelCount = async () => (await db.collection("parcels").get()).size;

  test("log line 3/4 scenario: create, then the identical retry replays the SAME parcel", async () => {
    const body = { ref: "JD55122", lockerId: "LK-2041", size: "medium" };
    const first = await post(body);
    const retry = await post(body);

    assert.equal(first.status, 201);
    assert.equal(first.headers.get("location"), `/v1/partners/jd/parcels/${first.json.id}`);
    assert.equal(first.json.size, "M", "alias normalised in the response");
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(retry.json, first.json, "replay returns the identical body");
    assert.equal(await parcelCount(), 1);
  });

  test("10 concurrent identical requests create exactly one parcel", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => post({ ref: "JD-RACE", lockerId: "LK-2041", size: "S" })));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 200).length, 9);
    assert.equal(new Set(results.map((r) => r.json.id)).size, 1);
    assert.equal(await parcelCount(), 1);
  });

  test("normalised-equal retry (trailing space, alias) is a replay, not a conflict", async () => {
    const a = await post({ ref: "JD1", lockerId: "LK-2041", size: "M" });
    const b = await post({ ref: " JD1", lockerId: "LK-2041 ", size: "medium" });
    assert.equal(b.status, 200);
    assert.equal(b.json.id, a.json.id);
  });

  test("same ref with different details -> 409 PARCEL_REF_CONFLICT, nothing created", async () => {
    await post({ ref: "JD2", lockerId: "LK-2041", size: "M" });
    const r = await post({ ref: "JD2", lockerId: "LK-3000", size: "M" });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "PARCEL_REF_CONFLICT");
    assert.equal(r.json.retryable, false);
    assert.equal(await parcelCount(), 1);
  });

  test("replay still succeeds after the locker went offline (idempotency beats current state)", async () => {
    const a = await post({ ref: "JD3", lockerId: "LK-2041", size: "L" });
    await db.collection("lockers").doc("LK-2041").update({ status: "offline" });
    const b = await post({ ref: "JD3", lockerId: "LK-2041", size: "L" });
    assert.equal(b.status, 200);
    assert.equal(b.json.id, a.json.id);
  });

  test("log line 1 scenario: unknown locker -> 422 LOCKER_NOT_FOUND (was a 500 TypeError)", async () => {
    const r = await post({ ref: "JD55120", lockerId: "LK-1187 ", size: "M" });
    assert.equal(r.status, 422);
    assert.equal(r.json.code, "LOCKER_NOT_FOUND");
    assert.deepEqual(r.json.errors, [{ field: "lockerId", message: "unknown locker" }]);
  });

  test("log line 1, the trailing space alone: trimmed and accepted when the locker exists", async () => {
    const r = await post({ ref: "JD4", lockerId: "LK-2041 ", size: "M" });
    assert.equal(r.status, 201);
    assert.equal(r.json.lockerId, "LK-2041");
    const entry = logs.find((e) => e.ref === "JD4");
    assert.match(entry.warnings.join(), /whitespace/, "the leniency is logged so we can tell JD");
  });

  test("log line 2 scenario: offline locker -> 409 LOCKER_OFFLINE, retryable, Retry-After (was 200 ok:false)", async () => {
    const r = await post({ ref: "JD55121", lockerId: "LK-0933", size: "M" });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "LOCKER_OFFLINE");
    assert.equal(r.json.retryable, true);
    assert.equal(r.headers.get("retry-after"), "300");
    assert.equal(await parcelCount(), 0);
  });

  test("validation: all field errors reported together, 400 VALIDATION_FAILED", async () => {
    const r = await post({ ref: 55, size: "XL" });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "VALIDATION_FAILED");
    assert.deepEqual(
      r.json.errors.map((e) => e.field),
      ["ref", "lockerId", "size"],
    );
  });

  test("malformed JSON -> 400 INVALID_JSON; wrong content type -> 415; oversized -> 413", async () => {
    assert.equal((await post(null, { raw: '{"ref":"JD5", bad' })).json.code, "INVALID_JSON");
    assert.equal((await post(null, { raw: "ref=JD5", contentType: "text/plain" })).status, 415);
    const big = await post({ ref: "JD6", lockerId: "LK-2041", size: "M", pad: "x".repeat(20_000) });
    assert.equal(big.status, 413);
  });

  test("auth: no key -> 401; JD's key on Evri's path -> 403", async () => {
    assert.equal((await post({ ref: "JD7", lockerId: "LK-2041", size: "M" }, { key: null })).status, 401);
    const r = await post({ ref: "JD7", lockerId: "LK-2041", size: "M" }, { partner: "evri" });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "FORBIDDEN");
    assert.equal(await parcelCount(), 0);
  });

  test("structured access log carries partner, ref, outcome, error code and severity", async () => {
    await post({ ref: "JD55121", lockerId: "LK-0933", size: "M" });
    const entry = logs.find((e) => e.ref === "JD55121");
    assert.equal(entry.severity, "WARNING");
    assert.equal(entry.partner, "jd");
    assert.equal(entry.errorCode, "LOCKER_OFFLINE");
    assert.equal(entry.httpRequest.status, 409);
  });
});
