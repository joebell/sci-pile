import {
  buildCandidateUrl,
  filenameForDoi,
  normalizeDoi,
  originPattern,
} from "./lib/core.js";
import { resolveDoiFromBibliographicMetadata } from "./lib/crossref.js";
import {
  buildPaperpileImportPublication,
  buildPaperpileLookupPublication,
  classifyPaperpileAttachment,
  choosePaperpileDuplicate,
  getPaperpileAttachmentIds,
  hasPaperpileMainPdf,
  isPaperpileLibraryUrl,
  isPaperpileAutoDownloadEnabled,
  PAPERPILE_PERSONAL_LIBRARY_ID,
} from "./lib/paperpile.js";
import { probeDocument } from "./lib/pdf.js";

const PREFIXES_KEY = "prefixes";
const JOB_PREFIX = "job:";
const PAPERPILE_APP_URL = "https://app.paperpile.com/my-library/all";
const PAPERPILE_APP_PATTERN = "https://app.paperpile.com/*";
const PAPERPILE_RPC_TIMEOUT_MS = 7_500;
const PAPERPILE_BRIDGE_HANDSHAKE_TIMEOUT_MS = 1_500;
const PAPERPILE_IMPORT_TIMEOUT_MS = 45_000;
const PAPERPILE_PDF_TIMEOUT_MS = 60_000;
const PAPERPILE_CALLBACK_READY_MS = 1_500;
const PAPERPILE_CALLBACK_HELPER_URL = "https://paperpile.com/";
const OFFSCREEN_DOCUMENT_PATH = "src/offscreen/offscreen.html";
const INTERACTION_TAB_PREFIX = "interaction-tab:";
let creatingOffscreenDocument = null;
const interactionResumesInFlight = new Set();

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const stored = await chrome.storage.sync.get(PREFIXES_KEY);
  if (!Array.isArray(stored[PREFIXES_KEY])) {
    await chrome.storage.sync.set({ [PREFIXES_KEY]: [] });
  }

  if (reason === "install") {
    await chrome.runtime.openOptionsPage();
  }
});

chrome.action.onClicked.addListener((tab) => {
  void resolvePdfFromTab(tab);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" || typeof changeInfo.title === "string") {
    void resumeJobForInteractionTab(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearInteractionTab(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "background") {
    return false;
  }

  let operation;
  if (message.type === "resolve-scholar-result") {
    operation = handleScholarResult(message, sender);
  } else if (message.type === "resolve-paperpile-reference") {
    operation = handlePaperpileReference(message, sender);
  } else {
    operation = handleStatusAction(message);
  }
  void operation
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});

async function resolvePdfFromTab(tab) {
  const doi = await extractDoi(tab);
  await resolvePdfForDoi(tab, doi);
}

async function resolvePdfForDoi(tab, doi, input = null) {
  const { prefixes = [] } = await chrome.storage.sync.get(PREFIXES_KEY);

  if (!prefixes.length) {
    await chrome.runtime.openOptionsPage();
    return;
  }

  const job = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    doi,
    status: doi ? "checking" : "no-doi",
    currentIndex: null,
    sourceTabId: Number.isInteger(tab?.id) ? tab.id : null,
    total: prefixes.length,
    attempts: [],
  };
  if (input) {
    job.input = input;
  }

  await saveJob(job);
  const statusTab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`src/status/status.html?job=${job.id}`),
  });
  job.statusTabId = Number.isInteger(statusTab.id) ? statusTab.id : null;
  await saveJob(job);

  if (!doi) {
    return;
  }

  for (const [index, prefix] of prefixes.entries()) {
    let candidateUrl;
    try {
      candidateUrl = buildCandidateUrl(prefix, doi);
    } catch (error) {
      job.attempts.push({
        prefix,
        status: "failed",
        error: errorMessage(error),
      });
      await saveJob(job);
      continue;
    }

    job.currentIndex = index;
    job.currentUrl = candidateUrl;
    job.currentDetails = {
      requestedUrl: candidateUrl,
      permissionOrigin: originPattern(prefix),
    };
    await saveJob(job);

    const hasPermission = await chrome.permissions.contains({
      origins: [originPattern(prefix)],
    });

    if (!hasPermission) {
      job.attempts.push({
        prefix,
        url: candidateUrl,
        status: "failed",
        error: "Site access has not been granted. Re-save the prefix in Options.",
        details: {
          requestedUrl: candidateUrl,
          permissionOrigin: originPattern(prefix),
          permissionGranted: false,
        },
      });
      await saveJob(job);
      continue;
    }

    try {
      const result = await probeDocument(candidateUrl);
      const attempt = {
        prefix,
        url: candidateUrl,
        finalUrl: result.finalUrl,
        status: "success",
        resultKind: result.kind,
        download: null,
        details: result.diagnostic,
      };
      job.attempts.push(attempt);

      if (result.kind === "pdf") {
        await completeResolvedPdf({
          job,
          resultEntry: attempt,
          pdfUrl: result.finalUrl,
          sourceTab: tab,
        });
        return;
      }

      job.status = "discovering";
      job.resultKind = "html";
      job.finalUrl = result.finalUrl;
      job.download = null;
      await saveJob(job);

      const discovery = await discoverPdfFromLandingHtml(
        result.html,
        result.finalUrl,
      );
      attempt.discovery = discovery;
      job.discovery = discovery;

      if (discovery.status === "pdf-found") {
        await completeResolvedPdf({
          job,
          resultEntry: discovery,
          pdfUrl: discovery.pdf.finalUrl,
          sourceTab: tab,
        });
        return;
      }

      await setInteractionRequired({
        job,
        url: result.finalUrl,
        discovery,
      });
      return;
    } catch (error) {
      job.attempts.push({
        prefix,
        url: candidateUrl,
        status: "failed",
        error: errorMessage(error),
        details: error?.diagnostic ?? {
          requestedUrl: candidateUrl,
          error: {
            name: error?.name ?? "Error",
            message: errorMessage(error),
          },
        },
      });
      await saveJob(job);
    }
  }

  job.status = "exhausted";
  job.currentIndex = null;
  delete job.currentUrl;
  delete job.currentDetails;
  await saveJob(job);
}

async function handleScholarResult(message, sender) {
  const senderUrl = sender?.tab?.url;
  if (!Number.isInteger(sender?.tab?.id) || !isGoogleScholarUrl(senderUrl)) {
    throw new Error("Sci-Pile accepts Scholar-result requests only from Google Scholar.");
  }

  const scholar = sanitizeScholarResult(message.result);
  let doi = normalizeDoi(scholar.doi);
  let doiLookup = null;
  if (!doi) {
    doiLookup = await resolveDoiFromBibliographicMetadata(scholar);
    doi = doiLookup.doi;
  }

  void resolvePdfForDoi(sender.tab, doi, {
    source: "google-scholar",
    scholar,
    doiLookup: doiLookup?.match ?? null,
  }).catch((error) => {
    console.error("Sci-Pile Scholar lookup failed after launch", error);
  });

  return { doi, match: doiLookup?.match ?? null };
}

async function handlePaperpileReference(message, sender) {
  const senderTab = sender?.tab;
  if (!Number.isInteger(senderTab?.id) || !isPaperpileLibraryUrl(senderTab.url)) {
    throw new Error("Sci-Pile accepts library-menu requests only from Paperpile.");
  }

  const doi = normalizeDoi(message.doi);
  if (!doi) {
    throw new Error("Sci-Pile could not identify a valid DOI for this reference.");
  }

  void resolvePdfForDoi(senderTab, doi, {
    source: "paperpile-library-menu",
  }).catch((error) => {
    console.error("Sci-Pile Paperpile-menu lookup failed after launch", error);
  });

  return { doi };
}

function sanitizeScholarResult(result) {
  const clean = (value, limit) => typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, limit)
    : null;
  const year = Number(result?.year);
  return {
    doi: clean(result?.doi, 300),
    title: clean(result?.title, 1_000),
    citation: clean(result?.citation, 2_000),
    year: Number.isInteger(year) && year >= 1000 && year <= 3000 ? year : null,
    resultUrl: clean(result?.resultUrl, 2_000),
  };
}

function isGoogleScholarUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "scholar.google.com";
  } catch {
    return false;
  }
}

async function completeResolvedPdf({
  job,
  resultEntry,
  pdfUrl,
  sourceTab,
  closeTabId,
}) {
  const download = await startPdfDownload(pdfUrl, job.doi);
  const paperpileStartedAt = Date.now();
  resultEntry.download = download;
  job.status = "paperpile";
  job.resultKind = "pdf";
  job.finalUrl = pdfUrl;
  job.download = download;
  job.paperpile = {
    status: "opening-paperpile",
    startedAt: new Date(paperpileStartedAt).toISOString(),
  };
  await saveJob(job);

  let paperpile;
  try {
    paperpile = await importPdfIntoPaperpile({
      doi: job.doi,
      pdfUrl,
      sourceTab,
      onProgress: async (progress) => {
        job.paperpile = {
          ...progress,
          startedAt: new Date(paperpileStartedAt).toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await saveJob(job);
      },
    });
  } catch (error) {
    paperpile = {
      status: "failed",
      error: errorMessage(error),
    };
  }

  paperpile.startedAt = new Date(paperpileStartedAt).toISOString();
  paperpile.completedAt = new Date().toISOString();
  paperpile.durationMs = Date.now() - paperpileStartedAt;

  resultEntry.paperpile = paperpile;
  job.paperpile = paperpile;
  job.status = "success";
  await saveJob(job);

  if (Number.isInteger(closeTabId)) {
    await unregisterInteractionTab(closeTabId);
    await chrome.tabs.remove(closeTabId).catch(() => null);
  }

  if (
    download.status === "started" &&
    paperpile.status === "success" &&
    Number.isInteger(job.statusTabId)
  ) {
    await chrome.tabs.remove(job.statusTabId).catch(() => null);
  }
}

async function discoverPdfFromLandingHtml(
  html,
  landingUrl,
  { credentials = "omit", extraCandidates = [] } = {},
) {
  const discovery = {
    status: "checking",
    landingUrl,
    candidates: [],
    attempts: [],
  };

  try {
    const inspection = await inspectLandingHtml(html, landingUrl);
    discovery.pageTitle = inspection.title;
    discovery.interaction = inspection.interaction;
    discovery.candidates = mergePdfCandidates(
      inspection.candidates,
      extraCandidates,
    );
  } catch (error) {
    discovery.status = "inspection-failed";
    discovery.error = errorMessage(error);
    return discovery;
  }

  if (!discovery.candidates.length) {
    discovery.status = "no-candidates";
    return discovery;
  }

  return await verifyPdfCandidates(discovery, { credentials });
}

async function verifyPdfCandidates(discovery, { credentials = "omit" } = {}) {
  for (const candidate of discovery.candidates) {
    const candidateAttempt = {
      url: candidate.url,
      source: candidate.source,
      status: "checking",
    };
    discovery.attempts.push(candidateAttempt);

    let permission;
    try {
      permission = originPattern(candidate.url);
    } catch (error) {
      candidateAttempt.status = "failed";
      candidateAttempt.error = errorMessage(error);
      continue;
    }

    const hasPermission = await chrome.permissions.contains({
      origins: [permission],
    });
    if (!hasPermission) {
      candidateAttempt.status = "permission-missing";
      candidateAttempt.permissionOrigin = permission;
      candidateAttempt.error = "Site access is required before this PDF candidate can be verified.";
      continue;
    }

    try {
      const result = await probeDocument(candidate.url, { credentials });
      candidateAttempt.resultKind = result.kind;
      candidateAttempt.finalUrl = result.finalUrl;
      candidateAttempt.details = result.diagnostic;

      if (result.kind === "pdf") {
        candidateAttempt.status = "success";
        discovery.status = "pdf-found";
        discovery.pdf = {
          source: candidate.source,
          requestedUrl: candidate.url,
          finalUrl: result.finalUrl,
          details: result.diagnostic,
        };
        return discovery;
      }

      candidateAttempt.status = "not-pdf";
      candidateAttempt.error = "The declared PDF URL returned HTML.";
    } catch (error) {
      candidateAttempt.status = "failed";
      candidateAttempt.error = errorMessage(error);
      candidateAttempt.details = error?.diagnostic;
    }
  }

  discovery.status = "no-verified-pdf";
  return discovery;
}

function mergePdfCandidates(...candidateLists) {
  const merged = [];
  const seen = new Set();
  for (const candidates of candidateLists) {
    for (const candidate of candidates ?? []) {
      if (!candidate?.url || seen.has(candidate.url)) {
        continue;
      }
      seen.add(candidate.url);
      merged.push(candidate);
    }
  }
  return merged.slice(0, 20);
}

async function inspectLandingHtml(html, baseUrl) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "parse-landing-html",
    html,
    baseUrl,
  });
  if (!response?.ok) {
    throw new Error(response?.error ?? "The background HTML parser did not respond.");
  }
  return response.result;
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  let exists = false;
  if ("getContexts" in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });
    exists = contexts.length > 0;
  } else {
    const clients = await self.clients.matchAll();
    exists = clients.some((client) => client.url === offscreenUrl);
  }

  if (exists) {
    return;
  }
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["DOM_PARSER"],
      justification: "Parse scholarly HTML metadata without opening a visible tab.",
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }
  await creatingOffscreenDocument;
}

async function setInteractionRequired({ job, url, discovery, tabId = null, error = null }) {
  const status = discovery?.interaction?.kind ?? "manual";
  let reason = discovery?.interaction?.reason;
  if (!reason && discovery?.status === "inspection-failed") {
    reason = "The landing page could not be inspected in the background.";
  }
  if (!reason && discovery?.status === "no-verified-pdf") {
    reason = "The landing page declared PDF links, but none could be verified automatically.";
  }
  if (!reason) {
    reason = "The landing page did not declare a PDF through standard metadata.";
  }

  job.status = "interaction-required";
  job.resultKind = "html";
  job.finalUrl = url;
  job.download = null;
  job.interaction = {
    ...(job.interaction ?? {}),
    kind: status,
    url,
    reason,
    tabId: Number.isInteger(tabId) ? tabId : job.interaction?.tabId ?? null,
    error,
  };
  await saveJob(job);
}

async function handleStatusAction(message) {
  const job = await getJob(message.jobId);
  if (!job) {
    throw new Error("The lookup is no longer available. Run the resolver again.");
  }

  if (message.type === "open-interaction-page") {
    return await openInteractionPage(job);
  }
  if (message.type === "continue-interaction") {
    return await resumeInteractionJob(job);
  }
  throw new Error("Unknown resolver action.");
}

async function openInteractionPage(job) {
  const existingTabId = job.interaction?.tabId;
  if (Number.isInteger(existingTabId)) {
    const existing = await chrome.tabs.get(existingTabId).catch(() => null);
    if (existing) {
      await registerInteractionTab(existingTabId, job.id);
      await chrome.tabs.update(existingTabId, { active: true });
      if (Number.isInteger(existing.windowId)) {
        await chrome.windows.update(existing.windowId, { focused: true }).catch(() => null);
      }
      return { tabId: existingTabId };
    }
  }

  const url = job.interaction?.url ?? job.finalUrl;
  if (!url) {
    throw new Error("No landing-page URL is available.");
  }
  const tab = await chrome.tabs.create({ url, active: true });
  job.interaction = {
    ...(job.interaction ?? {}),
    url,
    tabId: tab.id,
    openedAt: new Date().toISOString(),
    error: null,
  };
  await registerInteractionTab(tab.id, job.id);
  await saveJob(job);
  return { tabId: tab.id };
}

async function resumeJobForInteractionTab(tabId) {
  const stored = await chrome.storage.session.get(`${INTERACTION_TAB_PREFIX}${tabId}`);
  const jobId = stored[`${INTERACTION_TAB_PREFIX}${tabId}`];
  if (!jobId) {
    return;
  }

  const job = await getJob(jobId);
  if (
    job?.status !== "interaction-required" ||
    job.interaction?.tabId !== tabId
  ) {
    return;
  }

  await resumeInteractionJob(job).catch(async (error) => {
    const latest = await getJob(jobId);
    if (latest?.status === "interaction-required") {
      latest.interaction.error = errorMessage(error);
      await saveJob(latest);
    }
  });
}

async function resumeInteractionJob(job) {
  if (interactionResumesInFlight.has(job.id)) {
    return { status: "already-checking" };
  }

  interactionResumesInFlight.add(job.id);
  try {
    return await continueAfterInteraction(job);
  } finally {
    interactionResumesInFlight.delete(job.id);
  }
}

async function continueAfterInteraction(job) {
  const tabId = job.interaction?.tabId;
  if (!Number.isInteger(tabId)) {
    throw new Error("Open the source page before continuing.");
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    await unregisterInteractionTab(tabId);
    job.interaction.tabId = null;
    await saveJob(job);
    throw new Error("The source tab was closed. Open it again before continuing.");
  }

  const currentUrl = /^https?:\/\//i.test(tab.url ?? "")
    ? tab.url
    : job.interaction.url;
  job.status = "resuming";
  job.interaction.currentUrl = currentUrl;
  job.interaction.error = null;
  await saveJob(job);

  let result;
  try {
    result = await probeDocument(currentUrl, { credentials: "include" });
  } catch (error) {
    await setInteractionRequired({
      job,
      url: currentUrl,
      tabId,
      discovery: {
        status: "inspection-failed",
        error: errorMessage(error),
      },
      error: errorMessage(error),
    });
    return { status: "interaction-required" };
  }

  const resumeAttempt = {
    requestedUrl: currentUrl,
    finalUrl: result.finalUrl,
    resultKind: result.kind,
    details: result.diagnostic,
  };
  job.interaction.resumeAttempt = resumeAttempt;

  if (result.kind === "pdf") {
    const sourceTab = await getJobSourceTab(job, tab);
    await completeResolvedPdf({
      job,
      resultEntry: resumeAttempt,
      pdfUrl: result.finalUrl,
      sourceTab,
      closeTabId: tabId,
    });
    return { status: "success" };
  }

  job.status = "discovering";
  await saveJob(job);

  let liveCandidates = [];
  try {
    await waitForTabComplete(tabId, 15_000);
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: discoverStandardPdfUrlsFromPage,
    });
    liveCandidates = Array.isArray(injection?.result) ? injection.result : [];
  } catch (error) {
    resumeAttempt.liveInspectionError = errorMessage(error);
  }

  const discovery = await discoverPdfFromLandingHtml(
    result.html,
    result.finalUrl,
    { credentials: "include", extraCandidates: liveCandidates },
  );
  resumeAttempt.discovery = discovery;
  job.discovery = discovery;

  if (discovery.status === "pdf-found") {
    const sourceTab = await getJobSourceTab(job, tab);
    await completeResolvedPdf({
      job,
      resultEntry: discovery,
      pdfUrl: discovery.pdf.finalUrl,
      sourceTab,
      closeTabId: tabId,
    });
    return { status: "success" };
  }

  await setInteractionRequired({
    job,
    url: result.finalUrl,
    discovery,
    tabId,
  });
  return { status: "interaction-required" };
}

async function getJobSourceTab(job, fallbackTab) {
  if (Number.isInteger(job.sourceTabId) && job.sourceTabId !== fallbackTab?.id) {
    const sourceTab = await chrome.tabs.get(job.sourceTabId).catch(() => null);
    if (sourceTab) {
      return sourceTab;
    }
  }
  return fallbackTab;
}

async function registerInteractionTab(tabId, jobId) {
  if (!Number.isInteger(tabId) || !jobId) {
    return;
  }
  await chrome.storage.session.set({
    [`${INTERACTION_TAB_PREFIX}${tabId}`]: jobId,
  });
}

async function unregisterInteractionTab(tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }
  await chrome.storage.session.remove(`${INTERACTION_TAB_PREFIX}${tabId}`);
}

async function clearInteractionTab(tabId) {
  const key = `${INTERACTION_TAB_PREFIX}${tabId}`;
  const stored = await chrome.storage.session.get(key);
  const jobId = stored[key];
  await chrome.storage.session.remove(key);
  if (!jobId) {
    return;
  }

  const job = await getJob(jobId);
  if (
    job?.status === "interaction-required" &&
    job.interaction?.tabId === tabId
  ) {
    job.interaction.tabId = null;
    job.interaction.error = "The source tab was closed before a PDF was verified.";
    await saveJob(job);
  }
}

async function waitForTabComplete(tabId, timeoutMs) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") {
    return;
  }

  await new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timeoutId);
    };

    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish(resolve);
      }
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) {
        finish(() => reject(new Error("The landing-page tab was closed.")));
      }
    };

    const timeoutId = setTimeout(() => {
      finish(() => reject(new Error("Timed out while loading the landing page.")));
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

/**
 * Runs inside the landing page. It uses declared web metadata only and does
 * not inspect frames, embedded objects, scripts, or site-specific markup.
 */
function discoverStandardPdfUrlsFromPage() {
  const results = [];
  const seen = new Set();

  function add(value, source) {
    if (typeof value !== "string" || !value.trim()) {
      return;
    }

    try {
      const url = new URL(value.trim(), location.href);
      if (!["https:", "http:"].includes(url.protocol) || seen.has(url.href)) {
        return;
      }
      seen.add(url.href);
      results.push({ url: url.href, source });
    } catch {
      // Ignore malformed metadata values.
    }
  }

  for (const meta of document.querySelectorAll("meta[content]")) {
    const key = (meta.getAttribute("name") ?? meta.getAttribute("property") ?? "")
      .trim()
      .toLowerCase();
    if (key === "citation_pdf_url") {
      add(meta.getAttribute("content"), "citation_pdf_url");
    }
  }

  for (const link of document.querySelectorAll("link[href][type]")) {
    const type = (link.getAttribute("type") ?? "").split(";", 1)[0].trim().toLowerCase();
    const rel = new Set((link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/));
    if (type === "application/pdf" && (rel.has("alternate") || rel.has("enclosure"))) {
      add(link.getAttribute("href"), `link rel=${[...rel].join(" ")}`);
    }
  }

  for (const anchor of document.querySelectorAll('a[href][type="application/pdf" i]')) {
    add(anchor.getAttribute("href"), "typed PDF link");
  }

  function visitJsonLd(node, depth = 0) {
    if (depth > 12 || node === null || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        visitJsonLd(item, depth + 1);
      }
      return;
    }

    const formats = [node.encodingFormat, node.fileFormat]
      .flat()
      .filter((value) => typeof value === "string")
      .map((value) => value.toLowerCase());
    const declaresPdf = formats.some((value) =>
      value === "application/pdf" || value === "pdf"
    );

    if (declaresPdf) {
      add(node.contentUrl, "Schema.org JSON-LD contentUrl");
      add(node.url, "Schema.org JSON-LD url");
    }

    for (const value of Object.values(node)) {
      visitJsonLd(value, depth + 1);
    }
  }

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visitJsonLd(JSON.parse(script.textContent));
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }

  return results.slice(0, 20);
}

async function startPdfDownload(url, doi) {
  const filename = filenameForDoi(doi);

  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false,
    });

    return {
      status: "started",
      downloadId,
      filename,
    };
  } catch (error) {
    return {
      status: "failed",
      filename,
      error: errorMessage(error),
    };
  }
}

/**
 * Import through Paperpile's installed browser extension rather than handling
 * Paperpile authentication in this extension. Paperpile's content script on
 * app.paperpile.com exposes the same app-to-extension message bridge used by
 * its web UI.
 */
async function importPdfIntoPaperpile({ doi, pdfUrl, sourceTab, onProgress }) {
  await onProgress({ status: "opening-paperpile" });
  const paperpileTab = await getOrCreatePaperpileTab();

  await onProgress({ status: "connecting" });
  const extensionVersion = await waitForPaperpileBridge(paperpileTab.id);
  // The crawler reads proxy/download settings from this object. It is kept in
  // memory only and is never written to diagnostics or extension storage.
  const user = await executePaperpileRpc(paperpileTab.id, "utils.getUserFromDb", {});
  if (!user?._id) {
    await focusPaperpileTab(paperpileTab);
    throw new Error("Paperpile is not signed in or its local library is not ready.");
  }

  const lookupPublication = buildPaperpileLookupPublication(doi);
  let duplicate = await findPaperpileDuplicate(paperpileTab.id, lookupPublication);
  let recordAction = "existing";
  let automaticPdfLookupSuppressed = false;
  let automaticPdfLookupSuppressionError = null;

  if (!duplicate) {
    recordAction = "created";
    await onProgress({
      status: "creating-reference",
      recordAction,
      extensionVersion,
    });

    const callbackTab = await preparePaperpileCallbackTab({
      paperpileTab,
      sourceTab,
    });
    try {
      const importPublication = buildPaperpileImportPublication(doi, crypto.randomUUID());
      const importResult = await createPaperpileReference({
        paperpileTab,
        callbackTab,
        importPublication,
        lookupPublication,
        user,
      });
      automaticPdfLookupSuppressed = importResult.automaticPdfLookupSuppressed;
      automaticPdfLookupSuppressionError = importResult.automaticPdfLookupSuppressionError;
      duplicate = importResult.duplicate;
    } finally {
      if (callbackTab.temporary && Number.isInteger(callbackTab.id)) {
        await chrome.tabs.remove(callbackTab.id).catch(() => null);
      }
    }
    if (!duplicate) {
      throw new Error("Paperpile did not finish creating the DOI reference in time.");
    }
  }

  const publication = duplicate.pub;
  const publicationId = publication?._id ?? duplicate.publication_id;
  if (!publication || !publicationId) {
    throw new Error("Paperpile found the DOI but did not return its reference data.");
  }

  const libraryId = duplicate.library_id || PAPERPILE_PERSONAL_LIBRARY_ID;
  const existingAttachmentIds = new Set(getPaperpileAttachmentIds(publication));
  if (duplicate.attachment?._id) {
    existingAttachmentIds.add(duplicate.attachment._id);
  }
  const hadMainPdf = hasPaperpileMainPdf(publication) ||
    Number(duplicate.attachment?.article_pdf) === 1;

  await onProgress({
    status: "attaching-pdf",
    recordAction,
    publicationId,
    libraryId,
    hadMainPdf,
    extensionVersion,
  });

  const crawlPublication = {
    _id: publicationId,
    pubtype: publication.pubtype ?? "PP_ARTICLE",
    title: publication.title ?? "[No title]",
    doi: publication.doi ?? lookupPublication.doi,
    id_list: publication.id_list ?? lookupPublication.id_list,
    url: publication.url ?? [`https://doi.org/${lookupPublication.doi}`],
    pdf_url: { local: [pdfUrl] },
  };

  const crawlResult = await executePaperpilePdfJob(
    paperpileTab.id,
    {
      pub: crawlPublication,
      user,
      source: "webapp",
      libraryId,
    },
    publicationId,
    PAPERPILE_PDF_TIMEOUT_MS,
  );

  await executePaperpileRpc(paperpileTab.id, "utils.openPubInWebapp", {
    pub: { _id: publicationId },
    libraryId,
    panelToOpen: "attachments",
  }).catch(() => null);
  await focusPaperpileTab(paperpileTab);

  if (crawlResult.status === "failed") {
    throw new Error(crawlResult.error);
  }

  const attachment = crawlResult.attachment ?? null;
  const attachmentId = attachment?._id ?? null;
  const attachmentDisposition = classifyPaperpileAttachment({
    attachment,
    existingAttachmentIds,
    hadMainPdf,
  });

  return {
    status: crawlResult.status,
    recordAction,
    publicationId,
    libraryId,
    hadMainPdf,
    attachmentId,
    attachmentDisposition,
    automaticPdfLookupSuppressed,
    automaticPdfLookupSuppressionError,
    extensionVersion,
  };
}

async function getOrCreatePaperpileTab() {
  const tabs = await chrome.tabs.query({ url: PAPERPILE_APP_PATTERN });
  let tab = tabs.find((candidate) => isPaperpileLibraryUrl(candidate.url));

  if (!tab) {
    tab = await chrome.tabs.create({ url: PAPERPILE_APP_URL, active: true });
  }

  if (!Number.isInteger(tab.id)) {
    throw new Error("Paperpile could not be opened.");
  }

  // Paperpile's standalone /view/ surface does not reliably relay PDF-crawl
  // completion events. Always activate a full library surface before using
  // the app-to-extension bridge, including when reviving a discarded tab.
  await focusPaperpileTab(tab);
  await waitForTabComplete(tab.id, 30_000);
  return await chrome.tabs.get(tab.id);
}

async function preparePaperpileCallbackTab({ paperpileTab, sourceTab }) {
  const currentSourceTab = Number.isInteger(sourceTab?.id)
    ? await chrome.tabs.get(sourceTab.id).catch(() => null)
    : null;
  const sourceUrl = currentSourceTab?.url ?? "";
  const canUseSourceTab = Number.isInteger(currentSourceTab?.id) &&
    /^https?:\/\//i.test(sourceUrl) &&
    !sourceUrl.startsWith("https://app.paperpile.com/");

  let callbackTab;
  let temporary = false;
  if (canUseSourceTab) {
    callbackTab = currentSourceTab;
  } else {
    callbackTab = await chrome.tabs.create({
      url: PAPERPILE_CALLBACK_HELPER_URL,
      active: false,
    });
    temporary = true;
    await waitForTabComplete(callbackTab.id, 20_000);
  }

  if (!Number.isInteger(callbackTab?.id)) {
    throw new Error("Paperpile's reference-import callback tab could not be prepared.");
  }

  try {
    await executePaperpileRpc(paperpileTab.id, "app.reinject", {
      tabId: callbackTab.id,
    });
    await delay(PAPERPILE_CALLBACK_READY_MS);
    return { id: callbackTab.id, temporary };
  } catch (error) {
    if (temporary) {
      await chrome.tabs.remove(callbackTab.id).catch(() => null);
    }
    throw error;
  }
}

/**
 * Paperpile's proven bulk-import path creates the new record, but it reads the
 * saved auto-download preference again when the autocomplete callback creates
 * the publication. Keep that preference disabled until the new DOI is visible,
 * then restore the exact original value before attaching Sci-Pile's PDF.
 */
async function createPaperpileReference({
  paperpileTab,
  callbackTab,
  importPublication,
  lookupPublication,
  user,
}) {
  const shouldSuppressAutomaticPdf = isPaperpileAutoDownloadEnabled(user);
  const originalAutoDownloadValue = user.autoDownloadPDFs;
  let suppressionApplied = false;
  let suppressionError = null;

  if (shouldSuppressAutomaticPdf) {
    try {
      await executePaperpileRpc(paperpileTab.id, "utils.saveSettings", {
        settings: { autoDownloadPDFs: false },
        tabId: callbackTab.id,
      });
      suppressionApplied = true;
    } catch (error) {
      // Duplicate avoidance is best-effort. Preserve the proven import path if
      // this Paperpile version does not allow the preference to be changed.
      suppressionError = errorMessage(error);
    }
  }

  try {
    await executePaperpileRpc(paperpileTab.id, "utils.bulkImport", {
      pubs: [importPublication],
      tabId: callbackTab.id,
      collections: [],
      source: "context",
      libraryId: PAPERPILE_PERSONAL_LIBRARY_ID,
    });

    const duplicate = await waitForPaperpileDuplicate(
      paperpileTab.id,
      lookupPublication,
      PAPERPILE_IMPORT_TIMEOUT_MS,
    );
    return {
      duplicate,
      automaticPdfLookupSuppressed: suppressionApplied,
      automaticPdfLookupSuppressionError: suppressionError,
    };
  } finally {
    if (suppressionApplied) {
      try {
        await executePaperpileRpc(paperpileTab.id, "utils.saveSettings", {
          settings: { autoDownloadPDFs: originalAutoDownloadValue },
          tabId: callbackTab.id,
        });
      } catch (error) {
        throw new Error(
          `Paperpile's automatic-PDF preference could not be restored. ` +
          `Please re-enable it in Paperpile settings. ${errorMessage(error)}`,
        );
      }
    }
  }
}

async function waitForPaperpileBridge(tabId) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await executePaperpileRpc(
        tabId,
        "utils.getExtensionVersion",
        {},
        PAPERPILE_BRIDGE_HANDSHAKE_TIMEOUT_MS,
      );
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }

  throw new Error(
    `The Paperpile browser extension bridge is unavailable${lastError ? `: ${errorMessage(lastError)}` : "."}`,
  );
}

async function findPaperpileDuplicate(tabId, lookupPublication) {
  const result = await executePaperpileRpc(tabId, "remote.isExistingPub", {
    pub: lookupPublication,
  });
  return choosePaperpileDuplicate(result?.duplicates);
}

async function waitForPaperpileDuplicate(tabId, lookupPublication, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const duplicate = await findPaperpileDuplicate(tabId, lookupPublication);
    if (duplicate) {
      return duplicate;
    }
    await delay(750);
  }
  return null;
}

async function executePaperpileRpc(tabId, action, data, timeoutMs = PAPERPILE_RPC_TIMEOUT_MS) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: paperpileWindowRpc,
    args: [action, data, timeoutMs],
  });

  const response = injection?.result;
  if (!response?.ok) {
    throw new Error(response?.error ?? `Paperpile action ${action} failed.`);
  }
  return response.result;
}

/** Runs in an isolated world on app.paperpile.com. */
function paperpileWindowRpc(action, data, timeoutMs) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const observed = [];
    let settled = false;

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      window.removeEventListener("message", onMessage);
      resolve(value);
    };

    const onMessage = (event) => {
      const message = event.data;
      if (message?.type === "remote-message" && observed.length < 8) {
        observed.push({
          sourceIsWindow: event.source === window,
          origin: message.origin ?? null,
          target: message.target ?? null,
          action: message.action ?? null,
          idType: message.idType ?? null,
          idMatches: message.id === id,
        });
      }
      // Paperpile's cs -> webapp relay keeps idType="request" even though
      // this is the reply. Match the random request id, as Paperpile does.
      if (
        event.source !== window ||
        !message ||
        message.type !== "remote-message" ||
        message.origin !== "cs" ||
        message.target !== "webapp" ||
        message.id !== id
      ) {
        return;
      }

      const response = message.data && typeof message.data === "object"
        ? message.data
        : message;
      if (response.error) {
        const error = typeof response.error === "string"
          ? response.error
          : response.error.message ?? JSON.stringify(response.error);
        finish({ ok: false, error });
        return;
      }

      finish({
        ok: true,
        result: Object.prototype.hasOwnProperty.call(response, "result")
          ? response.result
          : null,
      });
    };

    const timeoutId = setTimeout(() => {
      const observation = observed.length
        ? ` Observed bridge messages: ${JSON.stringify(observed)}.`
        : " No Paperpile bridge messages were observed.";
      finish({
        ok: false,
        error: `Paperpile action ${action} timed out.${observation}`,
      });
    }, timeoutMs);

    window.addEventListener("message", onMessage);
    window.postMessage({
      type: "remote-message",
      origin: "webapp",
      target: "bg",
      action,
      data,
      id,
      idType: "request",
      tabId: null,
      transferables: {},
    }, "*");
  });
}

async function executePaperpilePdfJob(tabId, data, publicationId, timeoutMs) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: paperpileWindowPdfJob,
    args: [data, publicationId, timeoutMs],
  });

  const response = injection?.result;
  if (!response?.ok) {
    return {
      status: "failed",
      error: response?.error ?? "Paperpile could not start its PDF attachment job.",
    };
  }
  return response.result;
}

/**
 * Start Paperpile's own PDF-crawl job and observe its completion callback. The
 * callback is also consumed normally by the Paperpile web app.
 */
function paperpileWindowPdfJob(data, publicationId, timeoutMs) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    let settled = false;
    let rpcCompleted = false;

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      window.removeEventListener("message", onMessage);
      resolve(value);
    };

    const unwrapResponse = (message) =>
      message.data && typeof message.data === "object" ? message.data : message;

    const onMessage = (event) => {
      const message = event.data;
      if (
        event.source !== window ||
        !message ||
        message.type !== "remote-message" ||
        message.origin !== "cs" ||
        message.target !== "webapp"
      ) {
        return;
      }

      // Paperpile's content-script relay preserves the request idType on the
      // response. Its own web-app client therefore resolves by id alone.
      if (message.id === id) {
        const response = unwrapResponse(message);
        if (response.error) {
          const error = typeof response.error === "string"
            ? response.error
            : response.error.message ?? JSON.stringify(response.error);
          finish({ ok: false, error });
          return;
        }
        rpcCompleted = true;
        return;
      }

      const callbackAction = typeof message.action === "string"
        ? message.action.replace(/^(?:new|remote-action)-/, "")
        : "";
      if (callbackAction !== "webapp.pdfCrawlFinished" || message.idType !== "request") {
        return;
      }

      const payload = message.data && typeof message.data === "object"
        ? message.data
        : {};
      const eventPublicationId = payload.job?.data?.pub?._id ?? payload.pub?._id;
      if (eventPublicationId !== publicationId) {
        return;
      }

      if (payload.status === "finished" && payload.attachmentData && !payload.errorMsg) {
        finish({
          ok: true,
          result: {
            status: "success",
            attachment: payload.attachmentData,
          },
        });
        return;
      }

      if (payload.status === "finished" || payload.errorMsg || payload.error) {
        finish({
          ok: true,
          result: {
            status: "failed",
            error: payload.errorMsg ?? payload.error?.message ?? String(payload.error ?? "PDF attachment failed."),
          },
        });
      }
    };

    const timeoutId = setTimeout(() => {
      finish({
        ok: true,
        result: rpcCompleted
          ? { status: "queued" }
          : { status: "failed", error: "Paperpile did not acknowledge the PDF attachment job." },
      });
    }, timeoutMs);

    window.addEventListener("message", onMessage);
    window.postMessage({
      type: "remote-message",
      origin: "webapp",
      target: "bg",
      action: "utils.addPdfCrawlJob",
      data,
      id,
      idType: "request",
      tabId: null,
      transferables: {},
    }, "*");
  });
}

async function focusPaperpileTab(tab) {
  if (Number.isInteger(tab.id)) {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => null);
  }
  if (Number.isInteger(tab.windowId)) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => null);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function extractDoi(tab) {
  if (!tab.id) {
    return null;
  }

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanPageForFirstDoi,
    });
    return injection?.result ?? null;
  } catch {
    return null;
  }
}

/**
 * This function is serialized by chrome.scripting, so it must be self-contained.
 */
function scanPageForFirstDoi() {
  const doiPattern = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
  const trailingPunctuation = /[.,;:!?]+$/;

  function countCharacter(value, character) {
    return [...value].filter((item) => item === character).length;
  }

  function clean(value) {
    const match = value?.match(doiPattern);
    if (!match) {
      return null;
    }

    let doi = match[0].replace(trailingPunctuation, "");
    for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      while (
        doi.endsWith(closing) &&
        countCharacter(doi, closing) > countCharacter(doi, opening)
      ) {
        doi = doi.slice(0, -1).replace(trailingPunctuation, "");
      }
    }
    return doi || null;
  }

  // innerText follows rendered document order, which gives "first DOI" the
  // most useful meaning for a person looking at the page.
  const visibleTextDoi = clean(document.body?.innerText ?? "");
  if (visibleTextDoi) {
    return visibleTextDoi;
  }

  // Metadata is a useful fallback on publisher pages where the DOI is not
  // visible. Preserve DOM order when scanning the values.
  for (const element of document.querySelectorAll("meta[content], [data-doi]")) {
    const value = element.getAttribute("content") ?? element.getAttribute("data-doi");
    const doi = clean(value);
    if (doi) {
      return doi;
    }
  }

  return clean(location.href);
}

async function saveJob(job) {
  await Promise.all([
    chrome.storage.session.set({ [`${JOB_PREFIX}${job.id}`]: job }),
    chrome.storage.local.set({ lastJob: job }),
  ]);
}

async function getJob(jobId) {
  if (typeof jobId !== "string" || !jobId) {
    return null;
  }

  const key = `${JOB_PREFIX}${jobId}`;
  const session = await chrome.storage.session.get(key);
  if (session[key]) {
    return session[key];
  }
  const local = await chrome.storage.local.get("lastJob");
  return local.lastJob?.id === jobId ? local.lastJob : null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
