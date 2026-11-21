# Task 4: Debug a partner API and define its contract

JD reports that some parcels sent through our control API are **missing**, others **appear twice**, and some **get an error**. We have the Express endpoint and four lines from Cloud Logging.

**Scope and constraints:** a 30-minute timebox and no GCP project. The fixed API runs locally against the **Firestore emulator**, and the brief's scenarios are tested through real HTTP (Node tests plus a curl suite). Every response is validated against the published JSON Schemas. The `gcloud logging read` commands are **not executed**, but their regexes are tested against the brief's own log lines.

```text
task-4/
├── original/app.js                  # the endpoint as supplied (reference only)
├── logging/queries.sh               # Part 1: gcloud logging read (failures, duplicates, post-fix structured)
└── api/
    ├── src/app.js                   # Part 3: the fixed endpoint (auth, validation, idempotency, errors, logging)
    ├── src/validate.js  src/parcels.js  src/problem.js  src/server.js
    ├── schemas/v1/                  # Part 4: request + success + error JSON Schemas (2020-12)
    └── test/
        ├── unit/                    # validator + schema<->validator contract test
        ├── logging/                 # log-filter regexes vs the brief's log lines
        ├── emulator/api.test.js     # HTTP tests on the Firestore emulator
        └── curl/curl-tests.sh       # Part 3: one curl per case, with asserted status/body/headers
```

---

## Part 1: Every failed or suspicious request from JD in the last 24 hours

The obvious filter, `severity>=ERROR`, finds **one of the four** lines. "Failed or suspicious" here has five signals:

| Signal | Catches |
|---|---|
| `severity>=WARNING` | line 1 (crash) |
| HTTP 4xx/5xx in the access line | line 1 (500) |
| `"ok":false` in the response | **line 2**: a failure disguised as `200 OK` |
| whitespace around `lockerId`/`ref` | line 1 (`"LK-1187 "`) |
| `size` not in `S|M|L` | **lines 3 and 4** (`"medium"`) |
| the same `ref` *created* twice | **lines 3 and 4**: each line looks healthy on its own |

The first five are one query:

```bash
gcloud logging read '
  resource.type="cloud_run_revision"
  textPayload:"/v1/partners/jd/parcels"
  (
    severity>=WARNING
    OR textPayload=~" (4|5)[0-9]{2} [0-9]+ms"
    OR textPayload=~"\"ok\":false"
    OR textPayload=~"\"(lockerId|ref)\":\"(\\s[^\"]*|[^\"]*\\s)\""
    OR (textPayload:"body=" AND NOT textPayload=~"\"size\":\"(S|M|L)\"")
  )' \
  --project=ktsm-prod-4471 --freshness=1d --order=asc --limit=1000 \
  --format='table(timestamp, severity, textPayload)'
```

Duplicates need counting across lines, so they take a second step:

```bash
gcloud logging read '
  resource.type="cloud_run_revision"
  textPayload:"/v1/partners/jd/parcels"
  textPayload:"response={\"id\""' \
  --project=ktsm-prod-4471 --freshness=1d --limit=10000 --format=json \
| jq -r '.[].textPayload' | grep -oE '"ref":"[^"]*"' | sort | uniq -d
```

Both are in [`logging/queries.sh`](logging/queries.sh) (`./queries.sh failures|duplicates|structured|print`). `--freshness=1d` gives the last 24 hours without date arithmetic. Rows on separate lines are ANDed. `resource.type` assumes Cloud Run. **Verified offline:** [`test-log-filters.sh`](api/test/logging/test-log-filters.sh) sources the same regexes, flags all four brief lines, does *not* flag a healthy control line, and the duplicate pipeline outputs exactly `"ref":"JD55122"`.

**After the fix**, the API writes one structured JSON entry per request (`httpRequest`, `partner`, `ref`, `outcome`, `errorCode`, `warnings`), so the same question becomes a precise query with no regexes:

```text
resource.type="cloud_run_revision"
jsonPayload.partner="jd"
(httpRequest.status>=400 OR jsonPayload.outcome="replayed" OR jsonPayload.warnings:*)
```

---

## Part 2: Each log line: what went wrong, and what JD experienced

| # | Line | What went wrong | What JD experienced |
|---|---|---|---|
| 1 | `ERROR … 500 … TypeError: Cannot read properties of undefined (reading 'status') body={"ref":"JD55120","lockerId":"LK-1187 ",…}` | `lockerId` has a **trailing space**. No validation or trimming, so Firestore looked up `lockers/"LK-1187 "`, which doesn't exist. `get()` returned a non-existent snapshot, `.data()` was `undefined`, and `.status` threw. Any unknown `lockerId` crashes the same way, and a missing `lockerId` throws inside `doc()`. | **"Some get an error."** A 500 with no explanation for what is a client-side input problem (or an unknown locker). JD can't tell whether to fix the data or retry. If they retry, it fails identically. |
| 2 | `INFO … 200 … body={"ref":"JD55121","lockerId":"LK-0933",…} response={"ok":false,"error":"locker offline"}` | The locker is offline, so **no parcel was created**, but the API returned **`200 OK`**. The body shape also differs from success (`{ok,error}` versus `{id}`), and it's logged at INFO, so no alert fired. | **"Some parcels are missing."** Any HTTP client treats 2xx as success. JD recorded JD55121 as booked (or got `id: undefined`) and never retried. The parcel exists on their side only. |
| 3, 4 | Two identical requests for **JD55122**, one second apart, both `200` with **different ids** (`p_8812`, `p_8813`) | The endpoint isn't idempotent: every call runs `createParcel`, and nothing ties a parcel to the partner's `ref`. A client retry (timeout, network blip, a retry triggered by line 1-style 500s) or a double submit creates a second parcel. Also, `size:"medium"` (lines 1 and 2 send `"M"`) passes unvalidated and is stored as-is, so downstream allocation that expects `S|M|L` may never match it. | **"Others appear twice."** Two parcels for one physical parcel: possibly two compartments reserved and double billing. The `"medium"` parcels may also never be allocated: another route to "missing". |

Other defects in the code: no authentication (anyone can post as `/partners/jd`), the partner in the URL is trusted as-is, no body or `Content-Type` checks, unhandled errors return Express's default HTML 500, and there are no structured logs.

---

## Part 3: The fixed endpoint

[`api/src/app.js`](api/src/app.js), with [`validate.js`](api/src/validate.js), [`parcels.js`](api/src/parcels.js) and [`problem.js`](api/src/problem.js).

### Validation: strict where it's safe, tolerant where production depends on it
| Input | v1 behaviour | Why |
|---|---|---|
| `ref`, `lockerId`: 1–64 chars `[A-Za-z0-9._-]`, starting alphanumeric | otherwise **400** with field errors | Rejects junk such as `/`, empty values or numbers before they reach Firestore. All field errors are returned together. |
| **surrounding whitespace** (`"LK-1187 "`) | **trimmed** and logged as a warning | JD sends it today. Rejecting it would break a live client; trimming fixes line 1's root cause. |
| **`size`** `S`/`M`/`L`, or aliases `small`/`medium`/`large` | aliases **normalised to S/M/L** and logged | JD sends *both* `"M"` and `"medium"` in production and both currently succeed. Rejecting `"medium"` in v1 would itself be a breaking change. Anything else (`"XL"`, `"m"`) gets a 400. |
| unknown fields | **ignored** and logged | Tolerant reader; rejecting them could break a client that sends extras. |
| non-JSON `Content-Type`, malformed JSON, body > 16 KB | 415 / 400 / 413 | |

The warnings go into the structured log, so we can tell JD exactly what to clean up before v2 makes them errors.

### Idempotency: the partner's `ref` is the key
`(partner, ref)` identifies a parcel. One Firestore transaction reads `parcel_refs/{partner}_{base64url(ref)}` and the locker, then creates the parcel and the ref index **atomically**:

- **Same ref, same details:** `200 OK`, `Idempotent-Replayed: true`, and the **identical original body**. This holds even if the locker has gone offline since: a retry must report what already happened, not re-evaluate it.
- **Same ref, different details:** `409 PARCEL_REF_CONFLICT`, and nothing is created.
- **Concurrent first requests:** the transaction lets exactly one commit; the others re-run, see the index, and replay.

**Why not require an `Idempotency-Key` header?** JD's current client doesn't send one. Requiring it would be a breaking change, and it would leave today's retries unprotected. The partner's `ref` is already present on every retry, so it protects the existing integration unchanged. (A header is the right tool for endpoints *without* a natural key; it can be added later without breaking anything.)

### Status codes: one error format
Every error is **RFC 9457 Problem Details** (`application/problem+json`) with stable extension members: `code` (branch on this), `retryable`, `errors[]` (field-level problems) and `requestId` (also returned as the `X-Request-Id` header).

| Status | `code` | `retryable` | When |
|---|---|---|---|
| **201** | — | — | Parcel created. Body is the parcel; `Location` header set. |
| **200** | — | — | Idempotent replay. Identical body; `Idempotent-Replayed: true`. |
| 400 | `VALIDATION_FAILED` / `INVALID_JSON` | no | Bad input. All field errors listed. |
| 401 / 403 | `UNAUTHENTICATED` / `FORBIDDEN` | no | Missing or invalid API key, or JD's key used on `/partners/evri`. |
| 409 | `PARCEL_REF_CONFLICT` | no | `ref` already used with different details. |
| 409 | `LOCKER_OFFLINE` | **yes** (`Retry-After: 300`) | Locker exists but isn't accepting parcels. **Was a 200 (line 2).** |
| 413 / 415 | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` | no | |
| 422 | `LOCKER_NOT_FOUND` | no | Well-formed request naming an unknown locker. **Was a 500 (line 1).** |
| 500 / 503 | `INTERNAL` / `UNAVAILABLE` | **yes** | Our fault or transient (Firestore `UNAVAILABLE`/`ABORTED`/`DEADLINE_EXCEEDED` → 503 with `Retry-After`). |

Choices you might be asked about:
- **422, not 404, for an unknown locker.** The *URL* exists; a 404 tells clients the endpoint is wrong. The problem is a value in the body.
- **409, not 503, for an offline locker.** A 503 says *our service* is down and trips partner-side circuit breakers for every locker. A 409 with `retryable: true` says *this locker* is unavailable right now.
- **Retrying 5xx is now safe.** Because creation is idempotent, the guidance to partners becomes simple: on a `retryable` error, resend the **same** request with backoff.

**The success body stays compatible.** `id` remains a top-level field as in the original `{ "id": … }`, with extra fields added (`partner`, `ref`, `lockerId`, `size`, `status`, `createdAt`). Wrapping it in `{ok, data}` would break JD's client, which reads `response.id`.

**Authentication** (a finding, not in the brief's list): API key in `X-API-Key`, compared as SHA-256 hashes in constant time. Keys are injected from Secret Manager, and the URL partner must match the key's partner. If partners don't authenticate today, adding this is itself a breaking change, so it ships with `AUTH_MODE=report` (log only) first. Switch to `enforce` once the logs show every partner sending a valid key.

### curl commands for each case
[`api/test/curl/curl-tests.sh`](api/test/curl/curl-tests.sh) is runnable (`BASE_URL=… JD_KEY=… ./curl-tests.sh`) and asserts status, body (`jq`) and headers. The core cases:

```bash
URL=http://localhost:8080/v1/partners/jd/parcels; K="X-API-Key: jd-test-key"; J="Content-Type: application/json"

curl -i -X POST $URL -H "$J" -H "$K" -d '{"ref":"JD55122","lockerId":"LK-2041","size":"M"}'        # 201 + Location
curl -i -X POST $URL -H "$J" -H "$K" -d '{"ref":"JD55122","lockerId":"LK-2041","size":"M"}'        # 200, same id, Idempotent-Replayed: true
curl -i -X POST $URL -H "$J" -H "$K" -d '{"ref":"JD55122","lockerId":"LK-2041 ","size":"medium"}'  # 200, same id (normalised)
curl -i -X POST $URL -H "$J" -H "$K" -d '{"ref":"JD55122","lockerId":"LK-3000","size":"M"}'        # 409 PARCEL_REF_CONFLICT
curl -i -X POST $URL -H "$J" -H "$K" -d '{"ref":"JD55120","lockerId":"LK-1187 ","size":"M"}'       # 422 LOCKER_NOT_FOUND
curl -i -X POST $URL -H "$J" -H "$K" -d '{"ref":"JD55121","lockerId":"LK-0933","size":"M"}'        # 409 LOCKER_OFFLINE, Retry-After
curl -i -X POST $URL -H "$J" -H "$K" -d '{"ref":"JD55123","lockerId":"LK-2041","size":"XL"}'       # 400 VALIDATION_FAILED
curl -i -X POST $URL -H "$J" -H "$K" -d '{}'                                                       # 400, all three fields listed
curl -i -X POST $URL -H "$J" -H "$K" -d '{"ref":"JD1", bad-json}'                                  # 400 INVALID_JSON
curl -i -X POST $URL -H "Content-Type: text/plain" -H "$K" -d 'ref=JD1'                            # 415
curl -i -X POST $URL -H "$J" -d '{"ref":"JD1","lockerId":"LK-2041","size":"M"}'                    # 401
curl -i -X POST ${URL/jd/evri} -H "$J" -H "$K" -d '{"ref":"JD1","lockerId":"LK-2041","size":"M"}'  # 403
```
The script adds: a body over 16 KB → 413, an unknown route → 404 problem, and **5 simultaneous identical requests → exactly one 201 and four 200s with one id**.

---

## Part 4: The v1 contract

[`api/schemas/v1/`](api/schemas/v1/) (JSON Schema 2020-12):

- [`create-parcel.request.schema.json`](api/schemas/v1/create-parcel.request.schema.json): `ref`, `lockerId`, `size` required. The v1 tolerances (whitespace, `deprecated` size aliases, unknown fields) are written **into** the schema, so the contract describes what the server really accepts.
- [`parcel.response.schema.json`](api/schemas/v1/parcel.response.schema.json): the 201/200 body, `id` at the top level.
- [`problem.response.schema.json`](api/schemas/v1/problem.response.schema.json): every error (RFC 9457 plus `code`, `retryable`, `errors`, `requestId`), including the full list of codes.

**The schema and the code can't drift apart:** [`contract.test.js`](api/test/unit/contract.test.js) runs 16 edge-case bodies through *both* the schema and the server's validator and fails on any disagreement. The HTTP tests validate **every** response body against the response schemas.

**Rules built into v1 so it can grow without breaking anyone:**
- Clients **must ignore unknown response fields** (`additionalProperties: true`), so adding fields is non-breaking.
- `status` and error `code` are open strings with documented known values, not closed enums, so adding a value is non-breaking. Clients fall back on the HTTP status.
- `id` is opaque, so its format can change.

### Introducing a breaking change without disrupting Evri or JD
1. **Classify first.** Additive changes (a new optional request field, a new response field, a new error code) stay in **v1**. Breaking changes include removing or renaming a field, making a field required, rejecting what v1 accepts (strict `size`, no whitespace trimming), and changing a status code or the success shape. These **never** change v1 in place.
2. **Ship `/v2/partners/{partner}/parcels` alongside v1**, with its own schemas, backed by the same domain service and Firestore collections. v1 becomes a thin adapter that normalises its input and calls the same core. Both versions are tested in CI against their own schemas.
3. **Tell partners early, in-band and out of band.** A migration guide, a sandbox with v2 enabled, and per-partner key rotation if auth changes. On v1 responses, add the standard headers: `Deprecation: @1799020800` (RFC 9745, a structured date: here 2027-01-04), `Sunset: Mon, 05 Jul 2027 00:00:00 GMT` (RFC 8594), and `Link: <https://api.ktsm.example/docs/v2>; rel="successor-version"`.
4. **Measure per partner.** The structured logs already carry `partner`. Add `apiVersion`, and the v1 `warnings` show exactly which deprecated behaviours each partner still relies on (for example, "JD still sends `medium`"). Evri and JD migrate on their own schedules.
5. **Retire v1 only on evidence.** When v1 traffic is zero for a partner and they've signed off, stop accepting their v1 traffic. When it's zero for all partners after the sunset date, return `410 Gone` with a Problem body pointing to v2.
6. **For a single behaviour change**, an opt-in can come before the version bump (for example, a `Prefer: strict-validation` request header, or a per-partner flag), so a partner can test v2 semantics on v1 before migrating.

---

## Verification

Run locally with Node.js 22.22.2, Express 5.3.0, the Firestore emulator (Java 21) and curl/jq.

```bash
cd task-4/api
npm ci
npm test               # 7 unit + contract tests, 7 log-filter checks
npm run test:emulator  # 12 HTTP tests on the emulator, then the curl suite against the real server: 18/18 checks
```

```text
npm test              -> # pass 7  # fail 0;  log filters: 7 PASS
npm run test:emulator -> # pass 12 # fail 0;  curl: 15 cases + 3 header checks PASS, failures: 0
shellcheck            -> logging/queries.sh, curl-tests.sh, run-local.sh, test-log-filters.sh: clean
```

## Assumptions
- **`createParcel` internals weren't provided.** Creation is folded into the idempotent transaction. If `createParcel` has side effects outside Firestore (for example, calling a partner or allocation service), the ref record becomes a two-phase `pending → completed` record: claim the ref in a transaction, call `createParcel`, then complete the record. A retry that finds a `pending` record older than a timeout resumes or reconciles.
- **Locker and ref formats** weren't specified, so the validation is deliberately general (1–64 safe characters) rather than an invented `LK-\d{4}` pattern that could reject real lockers.
- **The logs are Cloud Run stdout text lines,** as the extract suggests. For GKE, change `resource.type`.
- `parcel_refs` grows with parcels. That's intended, because it's the permanent `(partner, ref)` uniqueness index. If refs may be reused after delivery, add a time-window policy and a TTL.

## AI usage for this task

See [`../AI_USAGE.md`](../AI_USAGE.md#task-4).
