export function isPaperpileBatchInteraction(job) {
  return job?.input?.source === "paperpile-batch-scan" &&
    typeof job.input.scanId === "string" &&
    typeof job.input.referenceId === "string" &&
    job.status === "interaction-required";
}

export function markPaperpileBatchInteractionSkipped(
  job,
  reason = "Skipped without a verified PDF.",
  completedAt = new Date().toISOString(),
) {
  if (!isPaperpileBatchInteraction(job)) {
    return false;
  }

  job.status = "exhausted";
  job.exhaustedReason = reason;
  job.currentIndex = null;
  job.completedAt = completedAt;
  job.interaction = {
    ...(job.interaction ?? {}),
    tabId: null,
    error: null,
    skippedAt: completedAt,
    skipReason: reason,
  };
  delete job.currentUrl;
  delete job.currentDetails;
  return true;
}
