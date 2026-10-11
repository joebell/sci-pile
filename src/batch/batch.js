const scanId = new URLSearchParams(location.search).get("scan");
const scanKey = scanId ? `scan:${scanId}` : null;
const summary = document.querySelector("#summary");
const notice = document.querySelector("#notice");
const list = document.querySelector("#references");
const selectAll = document.querySelector("#select-all");
const selectionCount = document.querySelector("#selection-count");
const startButton = document.querySelector("#start");
const copyButton = document.querySelector("#copy-diagnostics");
const selectedIds = new Set();
const knownSelectableIds = new Set();
const jobs = new Map();
let renderedScan = null;

document.querySelector("#open-options").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

selectAll.addEventListener("change", () => {
  if (!renderedScan) {
    return;
  }
  for (const reference of selectableReferences(renderedScan)) {
    if (selectAll.checked) {
      selectedIds.add(reference.id);
    } else {
      selectedIds.delete(reference.id);
    }
  }
  render(renderedScan);
});

startButton.addEventListener("click", async () => {
  if (!renderedScan || !selectedIds.size) {
    return;
  }

  startButton.disabled = true;
  startButton.textContent = "Starting…";
  clearNotice();
  try {
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "start-paperpile-scan",
      scanId: renderedScan.id,
      referenceIds: [...selectedIds],
    });
    if (!response?.ok) {
      throw new Error(response?.error ?? "The batch scan could not be started.");
    }
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error));
    startButton.disabled = false;
    startButton.textContent = "Download and attach selected PDFs";
  }
});

copyButton.addEventListener("click", async () => {
  if (!renderedScan) {
    return;
  }
  const diagnostics = JSON.stringify({
    ...renderedScan,
    jobs: Object.fromEntries(jobs),
  }, null, 2);
  try {
    await navigator.clipboard.writeText(diagnostics);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = diagnostics;
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  copyButton.textContent = "Copied";
  setTimeout(() => {
    copyButton.textContent = "Copy diagnostics";
  }, 1_500);
});

if (!scanKey) {
  renderMissingScan();
} else {
  void loadScan();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "session") {
      return;
    }
    if (changes[scanKey]?.newValue) {
      void acceptScan(changes[scanKey].newValue);
      return;
    }
    for (const [key, change] of Object.entries(changes)) {
      if (key.startsWith("job:") && change.newValue) {
        const job = change.newValue;
        if (job.input?.scanId === scanId) {
          jobs.set(job.id, job);
          if (renderedScan) {
            render(renderedScan);
          }
        }
      }
    }
  });
}

async function loadScan() {
  const stored = await chrome.storage.session.get(scanKey);
  if (!stored[scanKey]) {
    renderMissingScan();
    return;
  }
  await acceptScan(stored[scanKey]);
}

async function acceptScan(scan) {
  renderedScan = scan;
  const jobKeys = scan.references
    .map((reference) => reference.jobId)
    .filter(Boolean)
    .map((jobId) => `job:${jobId}`);
  if (jobKeys.length) {
    const stored = await chrome.storage.session.get(jobKeys);
    for (const job of Object.values(stored)) {
      if (job?.id) {
        jobs.set(job.id, job);
      }
    }
  }
  render(scan);
}

function render(scan) {
  renderedScan = scan;
  const selectable = selectableReferences(scan);
  for (const reference of selectable) {
    if (!knownSelectableIds.has(reference.id)) {
      knownSelectableIds.add(reference.id);
      selectedIds.add(reference.id);
    }
  }

  const counts = countStates(scan.references);
  summary.textContent = scanSummary(scan, counts);
  if (scan.error) {
    showNotice(scan.error);
  } else {
    clearNotice();
  }

  const displayed = scan.references.filter((reference) => reference.state !== "already-attached");
  list.replaceChildren(...displayed.map((reference) => referenceItem(reference, scan)));

  const selectedCount = selectable.filter((reference) => selectedIds.has(reference.id)).length;
  selectAll.disabled = scan.status !== "ready" || selectable.length === 0;
  selectAll.checked = selectable.length > 0 && selectedCount === selectable.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
  selectionCount.textContent = scan.status === "ready"
    ? `${selectedCount} of ${selectable.length} eligible selected`
    : progressText(counts);

  startButton.disabled = scan.status !== "ready" || selectedCount === 0;
  startButton.textContent = scan.status === "identifying"
    ? "Identifying papers…"
    : scan.status === "running"
      ? "Downloading and attaching…"
      : scan.status === "attention-required"
        ? "Source page needs attention"
        : scan.status === "complete"
          ? "Batch complete"
          : "Download and attach selected PDFs";
}

function referenceItem(reference, scan) {
  const item = document.createElement("li");
  item.className = "reference";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = selectedIds.has(reference.id);
  checkbox.disabled = scan.status !== "ready" || reference.state !== "ready";
  checkbox.setAttribute("aria-label", `Select ${reference.title}`);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) {
      selectedIds.add(reference.id);
    } else {
      selectedIds.delete(reference.id);
    }
    render(scan);
  });

  const details = document.createElement("div");
  const title = document.createElement("p");
  title.className = "reference-title";
  title.textContent = reference.title;
  details.append(title);

  const metadata = document.createElement("p");
  metadata.className = "reference-meta";
  metadata.textContent = [reference.citation, reference.year].filter(Boolean).join(" · ");
  if (metadata.textContent) {
    details.append(metadata);
  }

  if (reference.doi) {
    const doi = document.createElement("p");
    doi.className = "reference-meta doi";
    doi.textContent = `DOI ${reference.doi}`;
    details.append(doi);
  }

  if (reference.error) {
    const error = document.createElement("p");
    error.className = "reference-error";
    error.textContent = reference.error;
    details.append(error);
  }

  if (reference.state === "attention" && reference.jobId) {
    details.append(interactionActions(reference.jobId));
  }

  const badge = document.createElement("span");
  badge.className = `badge ${reference.state}`;
  badge.textContent = stateLabel(reference.state);
  item.append(checkbox, details, badge);
  return item;
}

function interactionActions(jobId) {
  const wrapper = document.createElement("div");
  wrapper.className = "reference-actions";
  const job = jobs.get(jobId);

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.textContent = "Open source page";
  openButton.addEventListener("click", () => void runJobAction(openButton, {
    target: "background",
    type: "open-interaction-page",
    jobId,
  }));
  wrapper.append(openButton);

  if (Number.isInteger(job?.interaction?.tabId)) {
    const continueButton = document.createElement("button");
    continueButton.type = "button";
    continueButton.textContent = job.interaction?.permissionOrigin
      ? "Allow source & continue"
      : "Continue";
    continueButton.addEventListener("click", () => void continueJob(continueButton, job));
    wrapper.append(continueButton);
  }
  return wrapper;
}

async function continueJob(button, job) {
  const permissionOrigin = job.interaction?.permissionOrigin;
  button.disabled = true;
  try {
    if (permissionOrigin) {
      const granted = await chrome.permissions.contains({ origins: [permissionOrigin] }) ||
        await chrome.permissions.request({ origins: [permissionOrigin] });
      if (!granted) {
        throw new Error(`Sci-Pile needs access to ${displayOrigin(permissionOrigin)} to continue.`);
      }
    }
    await runJobAction(button, {
      target: "background",
      type: "continue-interaction",
      jobId: job.id,
    });
  } catch (error) {
    button.disabled = false;
    showNotice(error instanceof Error ? error.message : String(error));
  }
}

async function runJobAction(button, message) {
  button.disabled = true;
  clearNotice();
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {
      throw new Error(response?.error ?? "The source action failed.");
    }
  } catch (error) {
    button.disabled = false;
    showNotice(error instanceof Error ? error.message : String(error));
  }
}

function selectableReferences(scan) {
  return scan.references.filter((reference) => reference.state === "ready");
}

function countStates(references) {
  const counts = {};
  for (const reference of references) {
    counts[reference.state] = (counts[reference.state] ?? 0) + 1;
  }
  return counts;
}

function scanSummary(scan, counts) {
  if (scan.status === "identifying") {
    return "Checking the selected references for attached PDFs and identifying missing-PDF records by DOI…";
  }
  if (scan.status === "running") {
    return `Working through the selected missing PDFs one at a time. ${progressText(counts)}`;
  }
  if (scan.status === "attention-required") {
    return "A source needs a browser verification, sign-in, or permission step. Complete that row to continue the queue.";
  }
  if (scan.status === "complete") {
    return `Finished. ${progressText(counts)}`;
  }
  const missing = (counts.ready ?? 0) + (counts.unresolved ?? 0);
  const totalSelected = scan.totalSelected ?? scan.total;
  const attached = scan.excludedAttached ?? counts["already-attached"] ?? 0;
  if (!missing) {
    return `None of the ${totalSelected} selected reference${totalSelected === 1 ? " is" : "s are"} missing a PDF.`;
  }
  const omitted = attached
    ? ` ${attached} reference${attached === 1 ? " with a PDF was" : "s with PDFs were"} omitted.`
    : "";
  return `${missing} of ${totalSelected} selected reference${totalSelected === 1 ? " is" : "s are"} missing a PDF.${omitted}`;
}

function progressText(counts) {
  const attached = counts.attached ?? 0;
  const paperpileQueued = counts["paperpile-queued"] ?? 0;
  const failed = (counts.failed ?? 0) + (counts["not-found"] ?? 0);
  const waiting = (counts.queued ?? 0) + (counts.running ?? 0) + (counts.attention ?? 0);
  return `${attached} attached, ${paperpileQueued} queued in Paperpile, ${failed} unsuccessful, ${waiting} remaining.`;
}

function stateLabel(state) {
  return ({
    "already-attached": "PDF already attached",
    identifying: "Identifying DOI",
    ready: "Missing PDF",
    unresolved: "DOI unavailable",
    queued: "Queued",
    running: "In progress",
    attention: "Needs attention",
    attached: "PDF attached",
    "paperpile-queued": "Queued in Paperpile",
    failed: "Import failed",
    "not-found": "No PDF found",
    skipped: "Not selected",
  })[state] ?? state;
}

function displayOrigin(pattern) {
  return String(pattern ?? "").replace(/\/\*$/, "").replace(/\/$/, "");
}

function showNotice(value) {
  notice.textContent = value;
  notice.hidden = false;
}

function clearNotice() {
  notice.textContent = "";
  notice.hidden = true;
}

function renderMissingScan() {
  summary.textContent = "This scan is no longer available. Return to Paperpile and start it again.";
  selectAll.disabled = true;
  startButton.disabled = true;
  copyButton.disabled = true;
}
