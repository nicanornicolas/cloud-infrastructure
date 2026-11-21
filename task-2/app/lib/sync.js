"use strict";

const { validateParcel } = require("./parcel");

class PartnerHttpError extends Error {
  constructor(status) {
    super(`Partner manifest returned HTTP ${status}`);
    this.status = status;
  }
}

/**
 * Partner manifest client. ASSUMED contract (the brief only shows `?since=10m` and `parcels`):
 *   GET <url>?since=<ISO-8601>[&cursor=<opaque>]  ->  { parcels: [...], nextCursor?: string|null }
 */
function makePartnerFetcher({ baseUrl, timeoutMs, fetchFn = fetch }) {
  return async function fetchPage({ since, cursor }) {
    const url = new URL(baseUrl);
    url.searchParams.set("since", new Date(since).toISOString());
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetchFn(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs), // a hung partner must not eat the whole function timeout
    });
    if (!res.ok) throw new PartnerHttpError(res.status);

    const body = await res.json();
    if (!body || !Array.isArray(body.parcels)) throw new Error("Partner manifest has no parcels array");
    return { parcels: body.parcels, nextCursor: body.nextCursor ?? null };
  };
}

/**
 * One sync run. Guarantees:
 *  - never overlaps another run: a Firestore lease that outlives the function timeout;
 *  - never skips a parcel: an absolute watermark (not "last 10 minutes") that only advances once
 *    every page of the window is durably published, re-read with a small overlap;
 *  - never times out mid-window: stops after a time budget, checkpoints the cursor, and the next
 *    run resumes exactly where this one stopped;
 *  - re-queues parcels that were waiting for a free compartment (bounded by maxWaitAttempts).
 * Duplicate publishes (overlap window, retries) are safe because reserveCompartment is idempotent.
 *
 * Dependencies are injected so the logic is unit-testable without GCP.
 */
async function runSync({ store, fetchPage, publish, config, runId, clock = Date.now, log = () => {} }) {
  const startedAt = clock();

  if (!(await store.acquireLease(runId, startedAt, config.syncLeaseMs))) {
    log("WARNING", "sync skipped: previous run still holds the lease", { runId });
    return { status: "skipped", runId };
  }

  try {
    const state = await store.loadState();
    const resumed = Boolean(state.inProgress);
    let window = state.inProgress ?? {
      since: Math.max(0, (state.lastSyncedAt ?? startedAt - config.initialLookbackMs) - config.overlapMs),
      windowEnd: startedAt, // becomes the next watermark; anything newer is picked up next run
      cursor: null,
      published: 0,
      rejected: 0,
    };
    let pages = 0;

    for (;;) {
      let page;
      try {
        page = await fetchPage({ since: window.since, cursor: window.cursor });
      } catch (err) {
        // A checkpointed cursor may have expired at the partner: restart the same window from the top.
        // Re-publishing is harmless (idempotent consumer); skipping would not be.
        if (resumed && window.cursor && err instanceof PartnerHttpError && [400, 404, 410].includes(err.status)) {
          log("WARNING", "checkpointed cursor rejected; restarting window", { runId, status: err.status });
          window = { ...window, cursor: null };
          continue;
        }
        throw err;
      }

      const valid = [];
      for (const parcel of page.parcels) {
        const check = validateParcel(parcel);
        if (check.ok) valid.push(parcel);
        else {
          // One bad row must not block the whole manifest forever; surface it instead.
          window.rejected += 1;
          log("ERROR", "manifest parcel rejected", { runId, reason: check.reason, parcel });
        }
      }

      // Concurrent publishes; the Pub/Sub client batches them into few RPCs. If any publish fails,
      // this throws and the watermark/cursor do NOT move past this page.
      await Promise.all(valid.map((parcel) => publish(parcel)));
      pages += 1;

      if (page.nextCursor && page.nextCursor === window.cursor) {
        throw new Error("Partner returned the same cursor twice; aborting to avoid an endless loop");
      }
      window = { ...window, cursor: page.nextCursor, published: window.published + valid.length };
      if (!page.nextCursor) break;

      await store.saveProgress(window); // checkpoint only after the page is durably published
      if (pages >= config.maxPagesPerRun || clock() - startedAt >= config.syncTimeBudgetMs) {
        log("WARNING", "sync time budget reached; will resume next run", { runId, pages, cursor: window.cursor });
        return { status: "partial", runId, pages, published: window.published, rejected: window.rejected };
      }
    }

    await store.completeWindow(window.windowEnd);
    const requeued = await requeueWaitingParcels({ store, publish, config, now: clock() });

    const result = { status: "ok", runId, pages, published: window.published, rejected: window.rejected, requeued };
    log("INFO", "sync complete", { ...result, since: new Date(window.since).toISOString() });
    return result;
  } finally {
    await store.releaseLease(runId);
  }
}

/** Re-publish parcels whose locker was full, once their next attempt is due. */
async function requeueWaitingParcels({ store, publish, config, now }) {
  const due = await store.findDueWaiting(now, config.requeueBatchSize);
  if (due.length === 0) return 0;
  await Promise.all(due.map(({ ref, lockerId }) => publish({ ref, lockerId }, { reason: "requeue" })));
  // Push nextAttemptAt forward only after publishing: a crash in between re-publishes (harmless)
  // rather than losing the parcel.
  await store.deferWaiting(
    due.map((d) => d.id),
    now + config.waitRetryIntervalMs,
  );
  return due.length;
}

module.exports = { runSync, requeueWaitingParcels, makePartnerFetcher, PartnerHttpError };
