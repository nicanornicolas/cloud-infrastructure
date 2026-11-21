# Task 3: Migrate a Firestore trigger to 2nd gen

A 1st gen function sends a "ready for pickup" notification when a shipment is delivered. Customers get the notification **many times**, and the **Firestore bill for `shipments` has risen sharply**.

**Scope and constraints:** a 30-minute timebox and no GCP project. Everything below was run on the **Firebase emulators** (Firestore + Functions), including the original function, so the incident is *reproduced* and not just explained. Deploy and log commands are a runbook marked **not executed**.

```text
task-3/
├── original/                    # the function as supplied (+ package.json pinned to firebase-functions 5.x for the repro)
├── functions/
│   ├── index.js                 # onShipmentDelivered (2nd gen) + onShipmentUpdate (1st gen hotfix, cutover only)
│   ├── lib/notify.js            # transition check + exactly-once notification (shared by both)
│   └── test/{unit,emulator,repro}/
├── firebase.json                # deploys/emulates functions/
└── firebase.repro.json          # emulates original/ (bug reproduction only)
```

---

## Part 1: What happens in production when a shipment is marked delivered

```text
producer: shipments/S1.status = "delivered"
   │
   ▼
① onShipmentUpdate(before={in_transit}, after={delivered})
   ├─ after.status == "delivered"  → notifications.add(...)          ← notification #1 (random ID)
   └─ shipments/S1.update({updatedAt: new Date()})                    ← writes the document it is triggered by
         │
         ▼
② onShipmentUpdate(before={delivered}, after={delivered, updatedAt: t1})
   ├─ after.status is STILL "delivered" → notifications.add(...)      ← notification #2
   └─ update({updatedAt: t2})   (t2 ≠ t1, so the document really changed)
         │
         ▼
③ ... ④ ... ⑤ ... forever                                            ← notification #3, #4, #5 ...
```

1. The producer updates `shipments/S1` to `status: "delivered"`. Firestore emits an update event and the function runs.
2. It checks `after.status === "delivered"`, which is true, and **adds** a notification with an auto-generated ID.
3. It then **always** writes `updatedAt: new Date()` back to the same document. Firestore triggers fire on every write, including ones made by the Admin SDK inside a function.
4. That write is an update, so the function runs again. It only looks at `after`, never at `before`, so `status` is *still* `"delivered"` and it **adds another notification**.
5. It writes a new `updatedAt`. Each value is a new timestamp, so the document always changes, the function runs again, and the loop never ends.

**Why "many notifications":** every iteration creates a new notification (`add()` with a random ID), so nothing can deduplicate them. Even without the loop, the same would happen on any redelivery of an event, and on any later update to an already-delivered shipment (a pickup code being set, for example).

**Why the bill:** each iteration costs one write to `shipments`, one to `notifications` and one function invocation. And **the `updatedAt` write is outside the `if`**: *every* update to *any* shipment (`in_transit → reserved`, for example) starts its own endless loop of writes to `shipments`, even when no notification is involved. As more shipments get touched, more documents loop permanently.

**Reproduced on the emulators** with the original code ([`test/repro/original.test.js`](functions/test/repro/original.test.js)):

```text
{"notificationsAfter8s":110,"notificationsAfter11s":247}    ← from ONE "delivered" update
ok - the loop is not specific to 'delivered': ANY update starts endless writes
```
(Exact counts vary from run to run, for example 121/273 on another run; it is consistently over 100 notifications within 8 seconds, still growing.)

Other issues: no retries (an event that fails is dropped), no region set (1st gen default `us-central1`, possibly far from the database), and `createdAt: new Date()` uses the client clock rather than `serverTimestamp()`. The code also only runs on firebase-functions ≤ 5.x: from v6 the package root exports the 2nd gen API.

---

## Part 2: The 2nd gen function

[`functions/index.js`](functions/index.js) (`onShipmentDelivered`) and [`functions/lib/notify.js`](functions/lib/notify.js):

| Requirement | Implementation |
|---|---|
| 2nd gen, `firebase-functions/v2/firestore` | `onDocumentUpdated({ document: "shipments/{shipmentId}", ... })` |
| `europe-west1`, retries enabled | `region: "europe-west1"`, `retry: true`. Also `maxInstances: 20`, `timeoutSeconds: 60`, `memory: "256MiB"`. |
| Fires only when status **changes to** delivered | `isDeliveredTransition(before, after)`: `after.status === "delivered" && before.status !== "delivered"`. Any other update returns immediately, without writing anything. |
| Must not trigger itself | The function **writes nothing to `shipments`**. The `updatedAt` write-back is removed: an audit timestamp belongs in the producer's own write (`FieldValue.serverTimestamp()`), not in a function triggered by that write. |
| Exactly one notification, even if the event is delivered more than once | **Deterministic ID** `notifications/{shipmentId}_ready_for_pickup`, created in a **transaction** that first checks the document and runs a query for *any* existing `ready_for_pickup` notification for that shipment. Two racing deliveries: the loser's create fails with `ALREADY_EXISTS`, which is treated as success. Transient errors are rethrown, so `retry: true` redelivers them, which is safe because the operation is idempotent. |

**Why the extra query, and not just `create()` on the deterministic ID?** Notifications created by the *old* code have random IDs. Without the query, a shipment notified by the old function a moment before the cutover could be notified again by the new one. The query covers that case. It costs one indexed read, and only on actual delivered transitions.

**Why key on `shipmentId` rather than `event.id`?** `event.id` only deduplicates redeliveries of *the same event*. During the cutover, the 1st gen and 2nd gen functions see the same transition as **two different events**, and only a business key deduplicates across them. Trade-off: `delivered → issue → delivered` won't notify twice. If that's wanted, key on `{shipmentId}_{deliveryAttempt}` instead.

**Retries are bounded.** `retry: true` redelivers through Eventarc/Pub/Sub, which keeps messages for 24 hours by default; it doesn't retry forever. Permanent conditions (a non-transition, an already-created notification) return normally rather than throwing, so only genuinely transient failures are retried.

**Region and database location:** Firestore 2nd gen triggers are delivered by Eventarc in the **database's** location, while the function runs in `europe-west1` as required. Check the database location before deploying (`gcloud firestore databases describe --format='value(locationId)'`). `europe-west1` or `eur3` keeps traffic within Europe. A database in `nam5` would mean cross-Atlantic delivery, which should be raised with the owners.

**Downstream:** whatever turns a `notifications` document into an SMS or push message must also be idempotent per document ID (for example, mark it `sentAt` in a transaction before sending). Otherwise its own retries bring back the duplicate-message complaint.

---

## Part 3: Cutover from 1st gen to 2nd gen

### Constraints
- **A 2nd gen function can't take over a 1st gen function's name** in place, so the new function gets a new name: `onShipmentDelivered`. The bundled upgrade guide says to *"Rename your new 2nd gen function with a different name… Deploy it alongside the old 1st gen function… The 1st gen function can be deleted once it has stopped receiving traffic."*
- **Deleting the 1st gen function first** would leave a gap while the 2nd gen function and its Eventarc trigger provision. Deliveries in that gap would be **missed**.
- **Running the *broken* 1st gen function alongside the 2nd gen one** would keep looping and creating random-ID **duplicates**.
- **1st gen has no Node.js 24 runtime.** Both functions deploy from one codebase, so `engines.node` stays `"22"` (supported by both until 2027-04-30) until the 1st gen function is deleted.

### Runbook (not executed)

```bash
export PROJECT_ID=<project>

# 0. Facts first
firebase use "$PROJECT_ID"
firebase functions:list                                         # where the 1st gen function lives (expect us-central1)
gcloud firestore databases describe --project="$PROJECT_ID" --format='value(locationId)'
cd functions && npm ci && npm test && cd ..                     # plus `npm run test:emulator` (Java 21+)
```

**Step 1: Stop the bleeding. Hotfix the 1st gen function in place** (same name, same region). This is urgent and doesn't depend on the migration.
```bash
firebase deploy --only functions:onShipmentUpdate
```
The hotfixed `onShipmentUpdate` (in [`index.js`](functions/index.js), marked *CUTOVER ONLY*) no longer writes `updatedAt` and uses **the same `createReadyForPickupNotification`**. Redeploying a 1st gen function keeps its trigger, so no events are lost. In-flight executions of the old code finish within seconds; their last `updatedAt` write triggers the new code, which exits without writing. **Every loop stops.**
Check: the function's invocation rate and the Firestore write rate on `shipments` drop to the normal level of business writes (Cloud Monitoring: `cloudfunctions.googleapis.com/function/execution_count`, `firestore.googleapis.com/document/write_count`).

**Step 2: Deploy the 2nd gen function alongside it.**
```bash
firebase deploy --only functions:onShipmentDelivered
```
From the moment its trigger is active, **both** functions receive every update. Whichever commits the transactional create first produces the notification; the other gets `duplicate`. That's proven on the emulators: both functions handled all 21 delivered transitions, the 1st gen created 21 notifications, and the 2nd gen logged 21 `duplicate`s, so each shipment ended up with exactly 1.

**Step 3: Verify the 2nd gen function is receiving and handling events.**
```bash
firebase functions:log --only onShipmentDelivered
gcloud functions logs read onShipmentDelivered --gen2 --region=europe-west1 --project="$PROJECT_ID" --limit=50
# 2nd gen = a Cloud Run service (name lowercased by Firebase); structured fields from logger.info:
gcloud logging read \
  'resource.type="cloud_run_revision"
   AND resource.labels.service_name="onshipmentdelivered"
   AND jsonPayload.message:"ready_for_pickup"' \
  --project="$PROJECT_ID" --freshness=1h --limit=50 \
  --format='table(timestamp, severity, jsonPayload.message, jsonPayload.shipmentId, jsonPayload.outcome)'
# Errors only (should be empty):
gcloud logging read 'resource.labels.service_name="onshipmentdelivered" AND severity>=ERROR' \
  --project="$PROJECT_ID" --freshness=1h --limit=20
```
Proceed only when, for real deliveries, each transition logs one `created` and one `duplicate` across the two functions, with no errors.

**Step 4: Remove the 1st gen function.** Delete the `onShipmentUpdate` export from `index.js` first, then:
```bash
firebase functions:delete onShipmentUpdate --region=us-central1 --force
```
Any event already in flight to the 1st gen function either completes or isn't needed, because the 2nd gen function processes the same transition independently.

**Step 5: Upgrade the runtime** now that nothing is 1st gen: set `"engines": {"node": "24"}` and run `firebase deploy --only functions:onShipmentDelivered` (an in-place revision).

**Rollback:** until step 4, removing the 2nd gen function (`firebase functions:delete onShipmentDelivered --region=europe-west1`) leaves the hotfixed 1st gen function handling everything correctly.

**Cleanup after the incident:** customers already received duplicates, and the duplicate `notifications` documents (random IDs, same `shipmentId`) can be found with a query or a BigQuery export and archived. Verify the bill trend over the following days.

---

## Verification

Run locally with Node.js 22.22.2 and Firebase emulators (`firebase-tools` 15.37.0, Java 21).

```bash
cd task-3/functions
npm ci
npm test              # unit: transition truth table, deterministic ID              -> 2/2
npm run test:emulator # emulators, BOTH functions loaded (cutover state)             -> 5/5
npm run test:repro    # emulators, ORIGINAL function: reproduces loop + duplicates  -> 2/2
```

| Test | Proves |
|---|---|
| *delivered transition creates exactly one notification, and the shipment is not written back* | one notification, deterministic ID; the shipment's `updateTime` equals the producer's write time, so **no self-triggered writes** happened |
| *updates that are not a transition into delivered create nothing* | other field changes, leaving delivered, and creating as delivered: no notification |
| *20 shipments delivered at once* | one notification each, with both functions racing |
| *same event delivered 10 times concurrently* | redelivery → one notification |
| *notification created by the OLD code is respected* | no duplicate across the cutover boundary |
| repro: *one delivered update → loop* | over 100 notifications in 8 s and still growing; the shipment keeps being rewritten |
| repro: *ANY update starts endless writes* | the billing cause isn't limited to delivered shipments |

## Assumptions and follow-ups

- **A shipment *created* with `status: "delivered"`** isn't notified, which matches the original `onUpdate` semantics. If that case exists, switch to `onDocumentWritten` and treat a missing `before` as "not delivered".
- **Notification sender:** must be idempotent per notification ID (see Part 2).
- **Monitoring:** alert on a ratio of function invocations to shipment writes above about 1.1, and on `duplicate_legacy` appearing after the cutover week. Either would point to a new loop or another producer.

## AI usage for this task

See [`../AI_USAGE.md`](../AI_USAGE.md#task-3).
