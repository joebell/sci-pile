import assert from "node:assert/strict";
import test from "node:test";

import {
  isPaperpileBatchInteraction,
  markPaperpileBatchInteractionSkipped,
} from "../src/lib/batch.js";

test("marks a paused Paperpile batch item exhausted so its queue can continue", () => {
  const job = {
    status: "interaction-required",
    currentIndex: 0,
    currentUrl: "https://example.test/10.1000/missing",
    currentDetails: { requestedUrl: "https://example.test/10.1000/missing" },
    input: {
      source: "paperpile-batch-scan",
      scanId: "scan-1",
      referenceId: "reference-1",
    },
    interaction: {
      tabId: 42,
      reason: "Source page needs attention.",
    },
  };

  assert.equal(isPaperpileBatchInteraction(job), true);
  assert.equal(markPaperpileBatchInteractionSkipped(
    job,
    "No PDF was available.",
    "2026-10-11T20:00:00.000Z",
  ), true);
  assert.equal(job.status, "exhausted");
  assert.equal(job.exhaustedReason, "No PDF was available.");
  assert.equal(job.currentIndex, null);
  assert.equal(job.currentUrl, undefined);
  assert.equal(job.currentDetails, undefined);
  assert.deepEqual(job.interaction, {
    tabId: null,
    reason: "Source page needs attention.",
    error: null,
    skippedAt: "2026-10-11T20:00:00.000Z",
    skipReason: "No PDF was available.",
  });
});

test("does not skip an ordinary single-paper interaction", () => {
  const job = {
    status: "interaction-required",
    input: { source: "google-scholar" },
    interaction: { tabId: 42 },
  };

  assert.equal(isPaperpileBatchInteraction(job), false);
  assert.equal(markPaperpileBatchInteractionSkipped(job), false);
  assert.equal(job.status, "interaction-required");
});

test("does not race a batch interaction that is already resuming", () => {
  const job = {
    status: "resuming",
    input: {
      source: "paperpile-batch-scan",
      scanId: "scan-1",
      referenceId: "reference-1",
    },
    interaction: { tabId: 42 },
  };

  assert.equal(isPaperpileBatchInteraction(job), false);
  assert.equal(markPaperpileBatchInteractionSkipped(job), false);
  assert.equal(job.status, "resuming");
});
