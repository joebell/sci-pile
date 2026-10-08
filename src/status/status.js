const jobId = new URLSearchParams(location.search).get("job");
const jobKey = jobId ? `job:${jobId}` : null;
const heading = document.querySelector("#heading");
const doiElement = document.querySelector("#doi");
const message = document.querySelector("#message");
const attempts = document.querySelector("#attempts");
const spinner = document.querySelector("#spinner");
const actions = document.querySelector("#actions");
const currentUrl = document.querySelector("#current-url");
const copyButton = document.querySelector("#copy-diagnostics");
const openResultButton = document.querySelector("#open-result");
const continueButton = document.querySelector("#continue-result");
let renderedJob = null;

document.querySelector("#open-options").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

document.querySelector("#close-tab").addEventListener("click", () => {
  window.close();
});

openResultButton.addEventListener("click", async () => {
  if (!renderedJob) {
    return;
  }

  try {
    if (renderedJob.status === "interaction-required" || renderedJob.status === "resuming") {
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "open-interaction-page",
        jobId: renderedJob.id,
      });
      if (!response?.ok) {
        message.textContent = response?.error ?? "The source page could not be opened.";
      }
      return;
    }

    if (renderedJob.finalUrl) {
      await chrome.tabs.create({ url: renderedJob.finalUrl });
    }
  } catch (error) {
    message.textContent = error instanceof Error
      ? error.message
      : "The source page could not be opened.";
  }
});

continueButton.addEventListener("click", async () => {
  if (!renderedJob) {
    return;
  }
  continueButton.disabled = true;
  continueButton.textContent = "Checking…";
  try {
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "continue-interaction",
      jobId: renderedJob.id,
    });
    if (!response?.ok) {
      message.textContent = response?.error ?? "The source page could not be checked.";
      continueButton.disabled = false;
      continueButton.textContent = "Continue";
    }
  } catch (error) {
    message.textContent = error instanceof Error
      ? error.message
      : "The source page could not be checked.";
    continueButton.disabled = false;
    continueButton.textContent = "Continue";
  }
});

copyButton.addEventListener("click", async () => {
  if (!renderedJob) {
    return;
  }

  const diagnostics = JSON.stringify(renderedJob, null, 2);
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
  }, 1500);
});

if (!jobKey) {
  renderMissingJob();
} else {
  void loadJob();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "session" && changes[jobKey]?.newValue) {
      render(changes[jobKey].newValue);
    }
    if (
      areaName === "local" &&
      changes.lastJob?.newValue?.id === jobId
    ) {
      render(changes.lastJob.newValue);
    }
  });
}

async function loadJob() {
  const stored = await chrome.storage.session.get(jobKey);
  let job = stored[jobKey];
  if (!job) {
    const local = await chrome.storage.local.get("lastJob");
    if (local.lastJob?.id === jobId) {
      job = local.lastJob;
    }
  }
  if (!job) {
    renderMissingJob();
    return;
  }
  render(job);
}

function render(job) {
  renderedJob = job;
  spinner.hidden = false;
  actions.hidden = true;
  continueButton.disabled = false;
  continueButton.textContent = "Continue";

  const interactionActive = ["interaction-required", "resuming"].includes(job.status);
  const paperpileFailed = job.status === "success" && job.paperpile?.status === "failed";
  openResultButton.hidden = !(interactionActive || paperpileFailed);
  openResultButton.textContent = interactionActive ? "Open source page" : "Open PDF";
  continueButton.hidden = !(
    job.status === "interaction-required" &&
    Number.isInteger(job.interaction?.tabId)
  );
  doiElement.textContent = job.doi ? `DOI ${job.doi}` : "";
  currentUrl.textContent = job.currentUrl ? `Trying: ${job.currentUrl}` : "";
  attempts.replaceChildren();

  for (const [index, attempt] of job.attempts.entries()) {
    const item = document.createElement("li");
    const marker = document.createElement("span");
    const details = document.createElement("div");
    const source = document.createElement("strong");
    const requestedUrl = document.createElement("code");
    const response = document.createElement("span");
    const finalUrl = document.createElement("code");
    const firstBytes = document.createElement("code");
    const error = document.createElement("span");

    marker.className = `attempt-marker ${attempt.status}`;
    marker.textContent = attempt.status === "success" ? "✓" : "×";
    source.textContent = `${index + 1}. ${attempt.prefix}`;
    requestedUrl.textContent = `Requested: ${attempt.details?.requestedUrl ?? attempt.url ?? "unknown"}`;
    requestedUrl.className = "attempt-url";
    response.textContent = responseSummary(attempt);
    response.className = "response-summary";
    error.textContent = attempt.error ?? resultMessage(attempt);
    error.className = attempt.status === "success" ? "success-message" : "error-message";

    details.append(source, requestedUrl, response);

    const responseFinalUrl = attempt.details?.response?.finalUrl;
    if (responseFinalUrl && responseFinalUrl !== attempt.details?.requestedUrl) {
      finalUrl.textContent = `Final URL: ${responseFinalUrl}`;
      finalUrl.className = "attempt-url";
      details.append(finalUrl);
    }

    const inspection = attempt.details?.inspection;
    if (inspection) {
      firstBytes.textContent = `First bytes: ${inspection.firstBytesHex || "(empty)"} | ${inspection.firstBytesText || "(empty)"}`;
      firstBytes.className = "byte-preview";
      details.append(firstBytes);
    }

    if (attempt.discovery) {
      const discoverySummary = document.createElement("span");
      discoverySummary.className = "discovery-summary";
      discoverySummary.textContent = discoveryMessage(attempt.discovery);
      details.append(discoverySummary);

      for (const discoveredAttempt of attempt.discovery.attempts ?? []) {
        const candidate = document.createElement("code");
        candidate.className = "attempt-url";
        candidate.textContent = `${discoveredAttempt.source}: ${discoveredAttempt.url} — ${discoveredAttempt.status}${discoveredAttempt.error ? ` (${discoveredAttempt.error})` : ""}`;
        details.append(candidate);
      }
    }

    details.append(error);
    item.append(marker, details);
    attempts.append(item);
  }

  if (job.status === "no-doi") {
    finish(
      "No DOI found",
      "The page did not contain a visible DOI, DOI metadata, or a DOI in its URL.",
    );
    return;
  }

  if (job.status === "exhausted") {
    finish(
      "No PDF found",
      `All ${job.total} configured source${job.total === 1 ? "" : "s"} were tried.`,
    );
    return;
  }

  if (job.status === "success") {
    heading.textContent = paperpileHeading(job.paperpile);
    message.textContent = completionMessage(job);
    spinner.hidden = true;
    currentUrl.textContent = "";
    actions.hidden = false;
    return;
  }

  if (job.status === "interaction-required") {
    heading.textContent = interactionHeading(job.interaction);
    message.textContent = interactionMessage(job.interaction);
    spinner.hidden = true;
    currentUrl.textContent = "";
    actions.hidden = false;
    return;
  }

  if (job.status === "resuming") {
    heading.textContent = "Checking the source again";
    message.textContent = "Using the browser session from the source tab to look for the PDF…";
    currentUrl.textContent = "";
    actions.hidden = false;
    return;
  }

  if (job.status === "paperpile") {
    heading.textContent = paperpileProgressHeading(job.paperpile);
    message.textContent = paperpileProgressMessage(job.paperpile);
    currentUrl.textContent = "";
    return;
  }

  if (job.status === "discovering") {
    heading.textContent = "Inspecting landing page";
    message.textContent = "Looking for standard PDF metadata and verifying any declared PDF URLs…";
    return;
  }

  const current = Number.isInteger(job.currentIndex) ? job.currentIndex + 1 : 1;
  heading.textContent = "Looking for a PDF";
  message.textContent = `Checking source ${current} of ${job.total}…`;
}

function paperpileHeading(paperpile) {
  if (paperpile?.status === "success") {
    return "Imported into Paperpile";
  }
  if (paperpile?.status === "queued") {
    return "Paperpile attachment queued";
  }
  if (paperpile?.status === "failed") {
    return "PDF found";
  }
  return "PDF found";
}

function completionMessage(job) {
  const paperpile = job.paperpile;
  if (paperpile?.status === "success") {
    const record = paperpile.recordAction === "created"
      ? "A new Paperpile reference was created"
      : "The existing Paperpile reference was found";
    let attachment = "and the PDF was attached";
    if (paperpile.attachmentDisposition === "additional") {
      attachment = "and the PDF was added as an additional file without replacing the main PDF";
    } else if (paperpile.attachmentDisposition === "already-present") {
      attachment = "and Paperpile confirmed that the same PDF was already attached";
    }
    return `${record} ${attachment}. Its listing is open. ${downloadMessage(job.download)}`;
  }

  if (paperpile?.status === "queued") {
    return `Paperpile accepted the attachment job and opened the reference listing, but did not report completion before the timeout. ${downloadMessage(job.download)}`;
  }

  if (paperpile?.status === "failed") {
    return `Paperpile import failed: ${paperpile.error}. Use Open PDF if you want to attach it manually. ${downloadMessage(job.download)}`;
  }

  return downloadMessage(job.download);
}

function paperpileProgressHeading(paperpile) {
  switch (paperpile?.status) {
    case "opening-paperpile":
      return "Opening Paperpile";
    case "creating-reference":
      return "Adding the reference to Paperpile";
    case "attaching-pdf":
      return "Attaching the PDF in Paperpile";
    default:
      return "Connecting to Paperpile";
  }
}

function paperpileProgressMessage(paperpile) {
  switch (paperpile?.status) {
    case "opening-paperpile":
      return "Opening and activating Paperpile before starting the import…";
    case "creating-reference":
      return "The DOI was not in the library. Paperpile is resolving its metadata and creating a reference…";
    case "attaching-pdf":
      return "The DOI is in the library. Paperpile is attaching the PDF without replacing existing files…";
    default:
      return "Checking the DOI against the signed-in Paperpile library…";
  }
}

function downloadMessage(download) {
  if (download?.status === "started") {
    return `A copy is also being saved as ${download.filename}.`;
  }
  if (download?.status === "failed") {
    return `The browser could not save a separate copy: ${download.error}`;
  }
  return "The PDF was found.";
}

function interactionHeading(interaction) {
  if (interaction?.kind === "challenge") {
    return "Browser verification required";
  }
  if (interaction?.kind === "login") {
    return "Sign-in required";
  }
  return "Source page needs attention";
}

function interactionMessage(interaction) {
  const nextStep = Number.isInteger(interaction?.tabId)
    ? "Complete any required step in the source tab. The extension will continue automatically when that tab finishes loading; Continue is available as a fallback."
    : "Open the source page only if you want to continue manually.";
  const error = interaction?.error ? ` Last check: ${interaction.error}` : "";
  return `${interaction?.reason ?? "The PDF could not be found in the background."} ${nextStep}${error}`;
}

function responseSummary(attempt) {
  const response = attempt.details?.response;
  if (!response) {
    if (attempt.details?.permissionGranted === false) {
      return `Permission missing for ${attempt.details.permissionOrigin}`;
    }
    return "No HTTP response was available.";
  }

  const parts = [`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`];
  if (response.contentType) {
    parts.push(response.contentType);
  }
  if (response.contentLength) {
    parts.push(`${response.contentLength} bytes declared`);
  }
  if (response.type) {
    parts.push(`response type ${response.type}`);
  }
  if (response.redirected) {
    parts.push("redirected");
  }
  return parts.join(" · ");
}

function resultMessage(attempt) {
  if (attempt.resultKind === "html") {
    return "HTML landing page found";
  }

  if (attempt.download?.status === "started") {
    return `PDF signature found; saving as ${attempt.download.filename}`;
  }

  if (attempt.download?.status === "failed") {
    return `PDF found, but the download could not start: ${attempt.download.error}`;
  }

  return "PDF signature found";
}

function discoveryMessage(discovery) {
  switch (discovery.status) {
    case "pdf-found":
      return `Standard discovery found and verified a PDF via ${discovery.pdf.source}.`;
    case "no-candidates":
      return "The landing page did not declare a PDF through supported standard metadata; it was not opened automatically.";
    case "no-verified-pdf":
      return "The landing page declared PDF candidates, but none could be verified.";
    case "inspection-failed":
      return `The landing page could not be inspected: ${discovery.error}`;
    default:
      return "Standard PDF discovery is still running.";
  }
}

function finish(title, body) {
  heading.textContent = title;
  message.textContent = body;
  spinner.hidden = true;
  currentUrl.textContent = "";
  actions.hidden = false;
}

function renderMissingJob() {
  finish("Lookup unavailable", "The lookup status is no longer available. Try the extension again.");
}
