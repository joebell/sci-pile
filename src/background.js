import {
  buildCandidateUrl,
  filenameForDoi,
  httpUrlFromTab,
  normalizeDoi,
  originPattern,
  originPatternForUrl,
} from "./lib/core.js";
import {
  resolveDoiFromAlternativeId,
  resolveDoiFromBibliographicMetadata,
} from "./lib/crossref.js";
import {
  isPaperpileBatchInteraction,
  markPaperpileBatchInteractionSkipped,
} from "./lib/batch.js";
import {
  buildPaperpileImportPublication,
  buildPaperpileLookupPublication,
  classifyPaperpileAttachment,
  choosePaperpileDuplicate,
  getPaperpileAttachmentIds,
  hasPaperpileCollectionIds,
  hasPaperpileMainPdf,
  isPaperpileLibraryUrl,
  isPaperpileAutoDownloadEnabled,
  mergePaperpileCollectionIds,
  paperpileCollectionIds,
  PAPERPILE_PERSONAL_LIBRARY_ID,
} from "./lib/paperpile.js";
import { probeDocument } from "./lib/pdf.js";
import {
  analyzeWebsiteRepairUrl,
  googleScholarSearchUrl,
} from "./lib/website-repair.js";

const PREFIXES_KEY = "prefixes";
const JOB_PREFIX = "job:";
const SCAN_PREFIX = "scan:";
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
const paperpileScansInFlight = new Set();
const paperpileDoiScansInFlight = new Set();
const paperpileRepairsInFlight = new Set();
const paperpileRepairIdentificationInFlight = new Set();

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
  if (
    changeInfo.status === "complete" ||
    typeof changeInfo.title === "string" ||
    typeof changeInfo.url === "string"
  ) {
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
  } else if (message.type === "create-paperpile-scan") {
    operation = handleCreatePaperpileScan(message, sender);
  } else if (message.type === "start-paperpile-scan") {
    operation = handleStartPaperpileScan(message, sender);
  } else if (message.type === "create-paperpile-repair") {
    operation = handleCreatePaperpileRepair(message, sender);
  } else if (message.type === "retry-paperpile-repair-identification") {
    operation = handleRetryPaperpileRepairIdentification(message, sender);
  } else if (message.type === "open-paperpile-repair-website") {
    operation = handleOpenPaperpileRepairWebsite(message, sender);
  } else if (message.type === "open-paperpile-repair-scholar") {
    operation = handleOpenPaperpileRepairScholar(message, sender);
  } else if (message.type === "set-paperpile-repair-doi") {
    operation = handleSetPaperpileRepairDoi(message, sender);
  } else if (message.type === "start-paperpile-repair") {
    operation = handleStartPaperpileRepair(message, sender);
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

async function resolvePdfForDoi(
  tab,
  doi,
  input = null,
  { openStatusTab = true, jobId = null } = {},
) {
  const { prefixes = [] } = await chrome.storage.sync.get(PREFIXES_KEY);

  if (!prefixes.length) {
    if (openStatusTab) {
      await chrome.runtime.openOptionsPage();
      return null;
    }
    throw new Error("Configure at least one source prefix before starting Sci-Pile.");
  }

  const job = {
    id: jobId ?? crypto.randomUUID(),
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
  if (openStatusTab) {
    const statusTab = await chrome.tabs.create({
      url: chrome.runtime.getURL(`src/status/status.html?job=${job.id}`),
    });
    job.statusTabId = Number.isInteger(statusTab.id) ? statusTab.id : null;
    await saveJob(job);
  }

  if (!doi) {
    return job;
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
        return job;
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
        return job;
      }

      await setInteractionRequired({
        job,
        url: result.finalUrl,
        discovery,
      });
      return job;
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
  await syncPaperpileScanFromJob(job);
  return job;
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

async function handleCreatePaperpileScan(message, sender) {
  const senderTab = sender?.tab;
  if (!Number.isInteger(senderTab?.id) || !isPaperpileLibraryUrl(senderTab.url)) {
    throw new Error("Sci-Pile accepts library-scan requests only from Paperpile.");
  }

  const references = sanitizePaperpileReferences(message.references);
  const selectionCount = Number.isSafeInteger(Number(message.selectionCount))
    ? Math.max(Number(message.selectionCount), references.length)
    : references.length;
  if (!selectionCount) {
    throw new Error("Select one or more Paperpile references before starting a scan.");
  }
  const missingReferences = references.filter((reference) => !reference.hasPdf);

  const scan = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    sourceTabId: senderTab.id,
    status: "identifying",
    total: missingReferences.length,
    totalSelected: selectionCount,
    excludedAttached: references.length - missingReferences.length,
    references: missingReferences.map((reference, index) => ({
      ...reference,
      id: `reference-${index + 1}`,
      missingPdf: true,
      state: reference.doi ? "ready" : "identifying",
      doiMatch: null,
      error: null,
      jobId: null,
    })),
  };

  await saveScan(scan);
  const reviewTab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`src/batch/batch.html?scan=${scan.id}`),
  });
  scan.reviewTabId = Number.isInteger(reviewTab.id) ? reviewTab.id : null;
  await saveScan(scan);

  void resolvePaperpileScanDois(scan.id).catch(async (error) => {
    const latest = await getScan(scan.id);
    if (!latest) {
      return;
    }
    latest.status = "ready";
    latest.error = errorMessage(error);
    latest.updatedAt = new Date().toISOString();
    await saveScan(latest);
  });

  return { scanId: scan.id, count: scan.total, totalSelected: scan.totalSelected };
}

async function handleCreatePaperpileRepair(message, sender) {
  const senderTab = sender?.tab;
  if (!Number.isInteger(senderTab?.id) || !isPaperpileLibraryUrl(senderTab.url)) {
    throw new Error("Sci-Pile accepts Website-repair requests only from Paperpile.");
  }

  const references = sanitizePaperpileReferences(message.references);
  const selectionCount = Number.isSafeInteger(Number(message.selectionCount))
    ? Math.max(Number(message.selectionCount), references.length)
    : references.length;
  if (!selectionCount) {
    throw new Error("Select one or more Paperpile references before starting a repair.");
  }

  const websites = references.filter((reference) => reference.pubtype === "PP_WEBSITE");
  const scan = {
    id: crypto.randomUUID(),
    kind: "website-repair",
    createdAt: new Date().toISOString(),
    sourceTabId: senderTab.id,
    status: "identifying",
    total: websites.length,
    totalSelected: selectionCount,
    excludedNonWebsite: references.length - websites.length,
    references: websites.map((reference, index) => {
      const url = reference.urls[0] ?? null;
      const doi = normalizeDoi(reference.doi) ?? normalizeDoi(url);
      return {
        ...reference,
        id: `reference-${index + 1}`,
        url,
        doi,
        resolvedTitle: null,
        state: doi ? "ready" : url ? "identifying" : "unresolved",
        error: url ? null : "This Website record has no usable HTTP or HTTPS link.",
        permissionOrigin: null,
        replacement: null,
      };
    }),
  };

  await saveScan(scan);
  const reviewTab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`src/batch/batch.html?scan=${scan.id}`),
  });
  scan.reviewTabId = Number.isInteger(reviewTab.id) ? reviewTab.id : null;
  await saveScan(scan);

  void identifyPaperpileRepairReferences(scan.id).catch(async (error) => {
    const latest = await getScan(scan.id);
    if (!latest) {
      return;
    }
    latest.status = "ready";
    latest.error = errorMessage(error);
    latest.updatedAt = new Date().toISOString();
    await saveScan(latest);
  });

  return { scanId: scan.id, count: scan.total, totalSelected: scan.totalSelected };
}

async function handleRetryPaperpileRepairIdentification(message, sender) {
  assertBatchReviewSender(sender);
  const scan = await getScan(message.scanId);
  const reference = scan?.references.find((candidate) => candidate.id === message.referenceId);
  if (!scan || scan.kind !== "website-repair" || !reference) {
    throw new Error("This Website repair is no longer available.");
  }
  if (["running", "complete"].includes(scan.status)) {
    throw new Error("Website identification cannot change after the repair queue starts.");
  }
  reference.state = "identifying";
  reference.error = null;
  reference.permissionOrigin = null;
  scan.status = "identifying";
  scan.updatedAt = new Date().toISOString();
  await saveScan(scan);
  await identifyPaperpileRepairReferences(scan.id, reference.id);
  return { scanId: scan.id, referenceId: reference.id };
}

async function handleOpenPaperpileRepairWebsite(message, sender) {
  assertBatchReviewSender(sender);
  const scan = await getScan(message.scanId);
  const reference = scan?.references.find((candidate) => candidate.id === message.referenceId);
  if (!scan || scan.kind !== "website-repair" || !reference?.url) {
    throw new Error("This Website link is no longer available.");
  }
  const tab = await chrome.tabs.create({ url: reference.url, active: true });
  return { tabId: tab.id ?? null };
}

async function handleOpenPaperpileRepairScholar(message, sender) {
  assertBatchReviewSender(sender);
  const scan = await getScan(message.scanId);
  const reference = scan?.references.find((candidate) => candidate.id === message.referenceId);
  if (!scan || scan.kind !== "website-repair" || !reference) {
    throw new Error("This Website repair is no longer available.");
  }
  const searchUrl = googleScholarSearchUrl(
    reference.searchQuery ?? analyzeWebsiteRepairUrl(reference.url).searchQuery,
  );
  if (!searchUrl) {
    throw new Error("Sci-Pile could not construct a useful Google Scholar query.");
  }
  const tab = await chrome.tabs.create({ url: searchUrl, active: true });
  return { tabId: tab.id ?? null, url: searchUrl };
}

async function handleSetPaperpileRepairDoi(message, sender) {
  assertBatchReviewSender(sender);
  const scan = await getScan(message.scanId);
  const reference = scan?.references.find((candidate) => candidate.id === message.referenceId);
  if (!scan || scan.kind !== "website-repair" || !reference) {
    throw new Error("This Website repair is no longer available.");
  }
  if (["running", "complete"].includes(scan.status)) {
    throw new Error("The DOI cannot change after the repair queue starts.");
  }
  const doi = normalizeDoi(message.doi);
  if (!doi) {
    throw new Error("Enter a valid DOI from the search result.");
  }
  reference.doi = doi;
  reference.state = "ready";
  reference.error = null;
  reference.permissionOrigin = null;
  reference.identification = {
    ...(reference.identification ?? {}),
    source: "manually confirmed DOI",
    manuallyConfirmedAt: new Date().toISOString(),
  };
  reference.updatedAt = new Date().toISOString();
  if (!scan.references.some((candidate) => candidate.state === "identifying")) {
    scan.status = "ready";
  }
  scan.updatedAt = reference.updatedAt;
  await saveScan(scan);
  return { scanId: scan.id, referenceId: reference.id, doi };
}

function assertBatchReviewSender(sender) {
  const expectedPrefix = chrome.runtime.getURL("src/batch/batch.html");
  const senderUrl = sender?.url ?? sender?.tab?.url;
  if (!senderUrl?.startsWith(expectedPrefix)) {
    throw new Error("Sci-Pile accepts this action only from its review page.");
  }
}

async function identifyPaperpileRepairReferences(scanId, onlyReferenceId = null) {
  const inFlightKey = onlyReferenceId ? `${scanId}:${onlyReferenceId}` : scanId;
  if (paperpileRepairIdentificationInFlight.has(inFlightKey)) {
    return;
  }
  paperpileRepairIdentificationInFlight.add(inFlightKey);

  try {
    let scan = await getScan(scanId);
    if (!scan || scan.kind !== "website-repair") {
      return;
    }
    const pending = scan.references.filter((reference) =>
      reference.state === "identifying" &&
      (!onlyReferenceId || reference.id === onlyReferenceId)
    );

    for (const original of pending) {
      let result;
      try {
        result = await identifyWebsiteReference(original);
      } catch (error) {
        result = {
          doi: null,
          error: `The Website could not be identified: ${errorMessage(error)}`,
        };
      }
      scan = await getScan(scanId);
      if (!scan || scan.kind !== "website-repair") {
        return;
      }
      const reference = scan.references.find((candidate) => candidate.id === original.id);
      if (!reference || reference.state !== "identifying") {
        continue;
      }

      reference.doi = result.doi ?? null;
      reference.resolvedTitle = result.title ?? null;
      reference.originalUrl = result.originalUrl ?? reference.originalUrl ?? null;
      reference.url = result.url ?? reference.url;
      reference.searchQuery = result.searchQuery ?? reference.searchQuery ?? null;
      reference.permissionOrigin = result.permissionOrigin ?? null;
      reference.state = result.doi ? "ready" : "unresolved";
      reference.error = result.doi ? null : result.error;
      reference.identification = result.details ?? null;
      reference.updatedAt = new Date().toISOString();
      scan.updatedAt = reference.updatedAt;
      await saveScan(scan);
    }

    scan = await getScan(scanId);
    if (!scan || scan.kind !== "website-repair") {
      return;
    }
    if (!scan.references.some((reference) => reference.state === "identifying")) {
      scan.status = "ready";
      scan.identificationCompletedAt = new Date().toISOString();
      scan.updatedAt = scan.identificationCompletedAt;
      await saveScan(scan);
    }
  } finally {
    paperpileRepairIdentificationInFlight.delete(inFlightKey);
  }
}

async function identifyWebsiteReference(reference) {
  const urlAnalysis = analyzeWebsiteRepairUrl(reference.url);
  const resultBase = {
    originalUrl: urlAnalysis.changed ? urlAnalysis.originalUrl : null,
    url: urlAnalysis.url ?? reference.url,
    searchQuery: urlAnalysis.searchQuery,
  };
  const recoveryDetails = {
    originalUrl: urlAnalysis.originalUrl,
    repairedUrl: urlAnalysis.url,
    changed: urlAnalysis.changed,
    repairReason: urlAnalysis.repairReason,
    alternativeIds: urlAnalysis.alternativeIds,
    titleHint: urlAnalysis.titleHint,
  };
  const directDoi = normalizeDoi(reference.doi) ??
    normalizeDoi(reference.url) ??
    normalizeDoi(urlAnalysis.url);
  if (directDoi) {
    return {
      ...resultBase,
      doi: directDoi,
      title: null,
      details: { source: "stored URL", urlRecovery: recoveryDetails },
    };
  }

  const lookupErrors = [];
  for (const alternativeId of urlAnalysis.alternativeIds) {
    try {
      const lookup = await resolveDoiFromAlternativeId(alternativeId);
      return {
        ...resultBase,
        doi: lookup.doi,
        title: lookup.title,
        details: {
          source: "Crossref publisher-identifier match",
          doiMatch: lookup.match,
          urlRecovery: recoveryDetails,
        },
      };
    } catch (error) {
      lookupErrors.push(errorMessage(error));
    }
  }

  if (!urlAnalysis.url) {
    return {
      ...resultBase,
      doi: null,
      error: "This Website record has no recoverable HTTP or HTTPS link.",
      details: { source: "URL recovery", urlRecovery: recoveryDetails },
    };
  }

  const permissionOrigin = originPatternForUrl(urlAnalysis.url);
  if (!await chrome.permissions.contains({ origins: [permissionOrigin] })) {
    return {
      ...resultBase,
      doi: null,
      permissionOrigin,
      error: `Site access is required to inspect ${new URL(urlAnalysis.url).hostname}.`,
      details: { source: "URL recovery", urlRecovery: recoveryDetails },
    };
  }

  let result;
  try {
    result = await probeDocument(urlAnalysis.url, { credentials: "include" });
  } catch (error) {
    const fallback = await identifyWebsiteFromTitleHint(urlAnalysis, lookupErrors);
    if (fallback) {
      return {
        ...resultBase,
        ...fallback,
        details: {
          ...fallback.details,
          fetchError: errorMessage(error),
          urlRecovery: recoveryDetails,
        },
      };
    }
    return {
      ...resultBase,
      doi: null,
      error: `The repaired Website could not be read: ${errorMessage(error)}`,
      details: {
        ...(error?.diagnostic ?? {}),
        lookupErrors,
        urlRecovery: recoveryDetails,
      },
    };
  }
  if (result.kind !== "html") {
    return {
      ...resultBase,
      doi: null,
      error: "The Website link returned a PDF without enough metadata to identify its reference.",
      details: { ...result.diagnostic, urlRecovery: recoveryDetails },
    };
  }

  const metadata = await inspectReferenceHtml(result.html, result.finalUrl);
  let doi = normalizeDoi(metadata.doi) ?? normalizeDoi(result.finalUrl);
  let doiMatch = null;
  let lookupError = null;
  if (!doi && metadata.title) {
    try {
      const lookup = await resolveDoiFromBibliographicMetadata(metadata);
      doi = lookup.doi;
      doiMatch = lookup.match ?? null;
    } catch (error) {
      lookupError = errorMessage(error);
    }
  }

  if (!doi && urlAnalysis.titleHint && urlAnalysis.titleHint !== metadata.title) {
    const fallback = await identifyWebsiteFromTitleHint(urlAnalysis, lookupErrors);
    if (fallback) {
      doi = fallback.doi;
      doiMatch = fallback.details?.doiMatch ?? doiMatch;
    }
  }

  return {
    ...resultBase,
    doi,
    title: metadata.title ?? null,
    error: doi
      ? null
      : lookupError ?? "No DOI was declared by the linked page.",
    details: {
      source: "linked Website",
      finalUrl: result.finalUrl,
      pageTitle: metadata.title ?? null,
      doiMatch,
      response: result.diagnostic?.response ?? null,
      lookupErrors,
      urlRecovery: recoveryDetails,
    },
  };
}

async function identifyWebsiteFromTitleHint(urlAnalysis, lookupErrors) {
  if (!urlAnalysis.titleHint) {
    return null;
  }
  try {
    const lookup = await resolveDoiFromBibliographicMetadata({
      title: urlAnalysis.titleHint,
      citation: "",
      year: null,
    });
    return {
      doi: lookup.doi,
      title: lookup.match?.title ?? urlAnalysis.titleHint,
      details: {
        source: "Crossref URL-title match",
        doiMatch: lookup.match,
      },
    };
  } catch (error) {
    lookupErrors.push(errorMessage(error));
    return null;
  }
}

async function inspectReferenceHtml(html, baseUrl) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "parse-reference-html",
    html,
    baseUrl,
  });
  if (!response?.ok) {
    throw new Error(response?.error ?? "The background reference parser did not respond.");
  }
  return response.result;
}

async function handleStartPaperpileScan(message, sender) {
  const expectedPrefix = chrome.runtime.getURL("src/batch/batch.html");
  const senderUrl = sender?.url ?? sender?.tab?.url;
  if (!senderUrl?.startsWith(expectedPrefix)) {
    throw new Error("Sci-Pile accepts batch actions only from its review page.");
  }

  const scan = await getScan(message.scanId);
  if (!scan) {
    throw new Error("This Paperpile scan is no longer available.");
  }
  if (scan.status === "identifying") {
    throw new Error("Wait for DOI identification to finish before starting.");
  }
  if (["running", "attention-required"].includes(scan.status)) {
    throw new Error("This Paperpile scan is already in progress.");
  }

  const { prefixes = [] } = await chrome.storage.sync.get(PREFIXES_KEY);
  if (!prefixes.length) {
    throw new Error("Configure at least one source prefix before starting Sci-Pile.");
  }

  const selectedIds = new Set(
    Array.isArray(message.referenceIds)
      ? message.referenceIds.filter((value) => typeof value === "string")
      : [],
  );
  const selected = scan.references.filter(
    (reference) => reference.state === "ready" && selectedIds.has(reference.id),
  );
  if (!selected.length) {
    throw new Error("Select at least one missing-PDF reference with an identified DOI.");
  }

  for (const reference of scan.references) {
    if (reference.state !== "ready") {
      continue;
    }
    reference.state = selectedIds.has(reference.id) ? "queued" : "skipped";
  }
  scan.status = "running";
  scan.startedAt = new Date().toISOString();
  scan.updatedAt = scan.startedAt;
  scan.error = null;
  await saveScan(scan);

  void runPaperpileScan(scan.id).catch(async (error) => {
    const latest = await getScan(scan.id);
    if (!latest) {
      return;
    }
    latest.status = "failed";
    latest.error = errorMessage(error);
    latest.updatedAt = new Date().toISOString();
    await saveScan(latest);
  });

  return { scanId: scan.id, selected: selected.length };
}

async function handleStartPaperpileRepair(message, sender) {
  assertBatchReviewSender(sender);
  const scan = await getScan(message.scanId);
  if (!scan || scan.kind !== "website-repair") {
    throw new Error("This Website repair is no longer available.");
  }
  if (scan.status === "identifying") {
    throw new Error("Wait for Website identification to finish before starting.");
  }
  if (scan.status === "running") {
    throw new Error("This Website repair is already in progress.");
  }

  const selectedIds = new Set(
    Array.isArray(message.referenceIds)
      ? message.referenceIds.filter((value) => typeof value === "string")
      : [],
  );
  const selected = scan.references.filter(
    (reference) => reference.state === "ready" && selectedIds.has(reference.id),
  );
  if (!selected.length) {
    throw new Error("Select at least one Website reference with an identified DOI.");
  }

  for (const reference of scan.references) {
    if (reference.state !== "ready") {
      continue;
    }
    reference.state = selectedIds.has(reference.id) ? "queued" : "skipped";
  }
  scan.status = "running";
  scan.startedAt = new Date().toISOString();
  scan.updatedAt = scan.startedAt;
  scan.error = null;
  await saveScan(scan);

  void runPaperpileRepair(scan.id).catch(async (error) => {
    const latest = await getScan(scan.id);
    if (!latest) {
      return;
    }
    latest.status = "failed";
    latest.error = errorMessage(error);
    latest.updatedAt = new Date().toISOString();
    await saveScan(latest);
  });

  return { scanId: scan.id, selected: selected.length };
}

function sanitizePaperpileReferences(references) {
  if (!Array.isArray(references)) {
    return [];
  }

  const clean = (value, limit) => typeof value === "string"
    ? value.replace(/[\u200b-\u200f\u2060\ufeff]/g, "").trim().replace(/\s+/g, " ").slice(0, limit)
    : "";
  const cleanList = (value, limit = 500) => Array.isArray(value)
    ? [...new Set(value.map((entry) => clean(entry, limit)).filter(Boolean))]
    : [];
  return references.slice(0, 5_000).map((reference) => {
    const year = Number(reference?.year);
    return {
      title: clean(reference?.title, 1_000),
      citation: clean(reference?.citation, 2_000),
      year: Number.isInteger(year) && year >= 1000 && year <= 3000 ? year : null,
      doi: normalizeDoi(reference?.doi),
      hasPdf: reference?.hasPdf === true,
      paperpileId: clean(reference?.paperpileId, 200),
      pubtype: clean(reference?.pubtype, 100).toUpperCase(),
      urls: cleanList(reference?.urls, 4_000).filter(isHttpUrl).slice(0, 20),
      folders: cleanList(reference?.folders, 200),
      labels: cleanList(reference?.labels, 200),
      libraryId: clean(reference?.libraryId, 200) || PAPERPILE_PERSONAL_LIBRARY_ID,
    };
  }).filter((reference) => reference.title);
}

function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

async function resolvePaperpileScanDois(scanId) {
  if (paperpileDoiScansInFlight.has(scanId)) {
    return;
  }
  paperpileDoiScansInFlight.add(scanId);

  try {
    let scan = await getScan(scanId);
    if (!scan) {
      return;
    }

    for (const original of scan.references) {
      if (original.state !== "identifying") {
        continue;
      }

      let doiLookup;
      try {
        doiLookup = await resolveDoiFromBibliographicMetadata(original);
      } catch (error) {
        doiLookup = { error: errorMessage(error) };
      }

      scan = await getScan(scanId);
      if (!scan || scan.status !== "identifying") {
        return;
      }
      const reference = scan.references.find((candidate) => candidate.id === original.id);
      if (!reference) {
        continue;
      }

      if (doiLookup.doi) {
        reference.doi = doiLookup.doi;
        reference.doiMatch = doiLookup.match ?? null;
        reference.state = "ready";
        reference.error = null;
      } else {
        reference.state = "unresolved";
        reference.error = doiLookup.error ?? "No unambiguous DOI match was found.";
      }
      scan.updatedAt = new Date().toISOString();
      await saveScan(scan);
    }

    scan = await getScan(scanId);
    if (!scan || scan.status !== "identifying") {
      return;
    }
    scan.status = "ready";
    scan.identificationCompletedAt = new Date().toISOString();
    scan.updatedAt = scan.identificationCompletedAt;
    await saveScan(scan);
  } finally {
    paperpileDoiScansInFlight.delete(scanId);
  }
}

async function runPaperpileScan(scanId) {
  if (paperpileScansInFlight.has(scanId)) {
    return;
  }
  paperpileScansInFlight.add(scanId);

  try {
    while (true) {
      const scan = await getScan(scanId);
      if (!scan) {
        return;
      }
      if (scan.references.some((reference) => reference.state === "attention")) {
        scan.status = "attention-required";
        scan.updatedAt = new Date().toISOString();
        await saveScan(scan);
        return;
      }

      const reference = scan.references.find((candidate) => candidate.state === "queued");
      if (!reference) {
        scan.status = "complete";
        scan.activeReferenceId = null;
        scan.completedAt = new Date().toISOString();
        scan.updatedAt = scan.completedAt;
        await saveScan(scan);
        return;
      }

      reference.state = "running";
      reference.jobId = crypto.randomUUID();
      reference.startedAt = new Date().toISOString();
      reference.error = null;
      scan.status = "running";
      scan.activeReferenceId = reference.id;
      scan.updatedAt = reference.startedAt;
      await saveScan(scan);

      const sourceTab = Number.isInteger(scan.sourceTabId)
        ? await chrome.tabs.get(scan.sourceTabId).catch(() => null)
        : null;
      let job;
      try {
        job = await resolvePdfForDoi(
          sourceTab,
          reference.doi,
          {
            source: "paperpile-batch-scan",
            scanId,
            referenceId: reference.id,
          },
          { openStatusTab: false, jobId: reference.jobId },
        );
      } catch (error) {
        const latest = await getScan(scanId);
        const current = latest?.references.find((candidate) => candidate.id === reference.id);
        if (latest && current) {
          current.state = "failed";
          current.error = errorMessage(error);
          current.completedAt = new Date().toISOString();
          latest.updatedAt = current.completedAt;
          await saveScan(latest);
        }
        continue;
      }

      await syncPaperpileScanFromJob(job, { continueRun: false });
      if (job.status === "interaction-required") {
        return;
      }
    }
  } finally {
    paperpileScansInFlight.delete(scanId);
  }
}

async function runPaperpileRepair(scanId) {
  if (paperpileRepairsInFlight.has(scanId)) {
    return;
  }
  paperpileRepairsInFlight.add(scanId);

  try {
    let lastReplacement = null;
    while (true) {
      const scan = await getScan(scanId);
      if (!scan || scan.kind !== "website-repair") {
        return;
      }
      const reference = scan.references.find((candidate) => candidate.state === "queued");
      if (!reference) {
        scan.status = "complete";
        scan.activeReferenceId = null;
        scan.completedAt = new Date().toISOString();
        scan.updatedAt = scan.completedAt;
        await saveScan(scan);
        if (lastReplacement) {
          await showPaperpileRepairResult(lastReplacement).catch(() => null);
        }
        return;
      }

      reference.state = "repairing";
      reference.startedAt = new Date().toISOString();
      reference.error = null;
      scan.status = "running";
      scan.activeReferenceId = reference.id;
      scan.updatedAt = reference.startedAt;
      await saveScan(scan);

      try {
        const result = await repairPaperpileWebsiteReference(reference, scan.sourceTabId);
        const latest = await getScan(scanId);
        const current = latest?.references.find((candidate) => candidate.id === reference.id);
        if (!latest || !current) {
          return;
        }
        current.state = "repaired";
        current.replacement = result;
        current.completedAt = new Date().toISOString();
        current.updatedAt = current.completedAt;
        latest.updatedAt = current.completedAt;
        latest.activeReferenceId = null;
        await saveScan(latest);
        lastReplacement = result;
      } catch (error) {
        const latest = await getScan(scanId);
        const current = latest?.references.find((candidate) => candidate.id === reference.id);
        if (!latest || !current) {
          return;
        }
        current.state = "failed";
        current.error = errorMessage(error);
        current.completedAt = new Date().toISOString();
        current.updatedAt = current.completedAt;
        latest.updatedAt = current.completedAt;
        latest.activeReferenceId = null;
        await saveScan(latest);
      }
    }
  } finally {
    paperpileRepairsInFlight.delete(scanId);
  }
}

async function repairPaperpileWebsiteReference(reference, sourceTabId) {
  if (!reference.paperpileId || !reference.doi) {
    throw new Error("The Website record is missing its Paperpile id or resolved DOI.");
  }

  const paperpileTab = await getOrCreatePaperpileTab();
  const extensionVersion = await waitForPaperpileBridge(paperpileTab.id);
  const user = await executePaperpileRpc(paperpileTab.id, "utils.getUserFromDb", {});
  if (!user?._id) {
    throw new Error("Paperpile is not signed in or its local library is not ready.");
  }

  const sourceLibraryId = reference.libraryId || PAPERPILE_PERSONAL_LIBRARY_ID;
  const original = await getPaperpilePublication(
    paperpileTab.id,
    reference.paperpileId,
    sourceLibraryId,
  );
  if (!original) {
    throw new Error("The original Website reference no longer exists in Paperpile.");
  }
  if (original.pubtype !== "PP_WEBSITE") {
    throw new Error("The original reference is no longer a Website, so it was left untouched.");
  }
  if (Number(original.trashed) === 1) {
    throw new Error("The original Website reference is already in Paperpile's Trash.");
  }

  const lookupPublication = buildPaperpileLookupPublication(reference.doi);
  let duplicate = await findPaperpileDuplicate(
    paperpileTab.id,
    lookupPublication,
    original._id,
    sourceLibraryId,
  );
  let recordAction = "existing";
  let automaticPdfLookupSuppressed = false;
  let automaticPdfLookupSuppressionError = null;

  if (!duplicate || duplicate.publication_id === original._id || duplicate.pub?._id === original._id) {
    recordAction = "created";
    const sourceTab = Number.isInteger(sourceTabId)
      ? await chrome.tabs.get(sourceTabId).catch(() => null)
      : null;
    const callbackTab = await preparePaperpileCallbackTab({ paperpileTab, sourceTab });
    try {
      const importResult = await createPaperpileReference({
        paperpileTab,
        callbackTab,
        importPublication: buildPaperpileImportPublication(reference.doi, crypto.randomUUID()),
        lookupPublication,
        user,
        excludePublicationId: original._id,
        libraryId: sourceLibraryId,
        requireLibraryMatch: true,
      });
      automaticPdfLookupSuppressed = importResult.automaticPdfLookupSuppressed;
      automaticPdfLookupSuppressionError = importResult.automaticPdfLookupSuppressionError;
      duplicate = importResult.duplicate;
    } finally {
      if (callbackTab.temporary && Number.isInteger(callbackTab.id)) {
        await chrome.tabs.remove(callbackTab.id).catch(() => null);
      }
    }
  }

  const replacementId = duplicate?.pub?._id ?? duplicate?.publication_id;
  const replacementLibraryId = duplicate?.library_id || sourceLibraryId;
  if (!replacementId || replacementId === original._id) {
    throw new Error("Paperpile did not create or find a distinct replacement reference.");
  }

  let replacement = await getPaperpilePublication(
    paperpileTab.id,
    replacementId,
    replacementLibraryId,
  );
  if (!replacement) {
    throw new Error("The replacement reference could not be verified in Paperpile.");
  }
  if (replacement.pubtype === "PP_WEBSITE") {
    throw new Error(
      "Paperpile matched another Website record instead of a scholarly reference; " +
      "the original Website record was left untouched.",
    );
  }

  const originalFolders = mergePaperpileCollectionIds(
    original.folders,
    original.folder_ids,
    reference.folders,
  );
  const originalLabels = mergePaperpileCollectionIds(
    original.labels,
    original.label_ids,
    original.tags,
    reference.labels,
  );
  const mergedFolders = mergePaperpileCollectionIds(replacement.folders, originalFolders);
  const mergedLabels = mergePaperpileCollectionIds(replacement.labels, originalLabels);
  if (
    originalFolders.length ||
    originalLabels.length ||
    Number(replacement.trashed) === 1
  ) {
    const updated = await executePaperpileRpc(
      paperpileTab.id,
      "data-layer.updatePublication",
      {
        id: replacementId,
        data: { folders: mergedFolders, labels: mergedLabels, trashed: 0 },
        libraryId: replacementLibraryId,
      },
    );
    if (!updated) {
      throw new Error("Paperpile did not accept the replacement's folder and label update.");
    }
    replacement = await getPaperpilePublication(
      paperpileTab.id,
      replacementId,
      replacementLibraryId,
    );
    if (
      !replacement ||
      Number(replacement.trashed) === 1 ||
      !hasPaperpileCollectionIds(replacement.folders, originalFolders) ||
      !hasPaperpileCollectionIds(replacement.labels, originalLabels)
    ) {
      throw new Error(
        "The replacement's folders and labels could not be verified; the Website record was left untouched.",
      );
    }
  }

  const trashed = await executePaperpileRpc(
    paperpileTab.id,
    "data-layer.updatePublication",
    {
      id: original._id,
      data: { trashed: 1 },
      libraryId: sourceLibraryId,
    },
  );
  if (!trashed) {
    throw new Error("Paperpile did not accept the request to move the Website record to Trash.");
  }
  const verifiedOriginal = await getPaperpilePublication(
    paperpileTab.id,
    original._id,
    sourceLibraryId,
  );
  if (Number(verifiedOriginal?.trashed) !== 1) {
    throw new Error("The replacement exists, but moving the Website record to Trash could not be verified.");
  }

  return {
    status: "success",
    recordAction,
    publicationId: replacementId,
    libraryId: replacementLibraryId,
    originalPublicationId: original._id,
    transferredFolders: paperpileCollectionIds(originalFolders),
    transferredLabels: paperpileCollectionIds(originalLabels),
    automaticPdfLookupSuppressed,
    automaticPdfLookupSuppressionError,
    extensionVersion,
  };
}

async function getPaperpilePublication(tabId, id, libraryId) {
  return await executePaperpileRpc(tabId, "api-backend.getPub", {
    id,
    libraryId,
    syncFirst: false,
  });
}

async function showPaperpileRepairResult(result) {
  const paperpileTab = await getOrCreatePaperpileTab();
  await executePaperpileRpc(paperpileTab.id, "utils.openPubInWebapp", {
    pub: { _id: result.publicationId },
    libraryId: result.libraryId,
  });
  await focusPaperpileTab(paperpileTab);
}

async function syncPaperpileScanFromJob(job, { continueRun = true } = {}) {
  const input = job?.input;
  if (input?.source !== "paperpile-batch-scan" || !input.scanId || !input.referenceId) {
    return;
  }

  const scan = await getScan(input.scanId);
  const reference = scan?.references.find((candidate) => candidate.id === input.referenceId);
  if (!scan || !reference) {
    return;
  }

  reference.jobId = job.id;
  reference.updatedAt = new Date().toISOString();
  if (job.status === "success") {
    reference.state = job.paperpile?.status === "failed"
      ? "failed"
      : job.paperpile?.status === "queued"
        ? "paperpile-queued"
        : "attached";
    reference.error = job.paperpile?.status === "failed" ? job.paperpile.error : null;
    reference.paperpile = job.paperpile ?? null;
    reference.download = job.download ?? null;
    reference.completedAt = reference.updatedAt;
  } else if (job.status === "exhausted") {
    reference.state = "not-found";
    reference.error = job.exhaustedReason ?? "No configured source returned a verified PDF.";
    reference.completedAt = reference.updatedAt;
  } else if (job.status === "interaction-required") {
    reference.state = "attention";
    reference.error = job.interaction?.reason ?? "The source page needs attention.";
    scan.status = "attention-required";
  } else {
    reference.state = "running";
  }

  scan.activeReferenceId = ["running", "attention"].includes(reference.state)
    ? reference.id
    : null;
  scan.updatedAt = reference.updatedAt;
  await saveScan(scan);

  if (
    continueRun &&
    ["attached", "paperpile-queued", "failed", "not-found"].includes(reference.state)
  ) {
    queueMicrotask(() => {
      void runPaperpileScan(scan.id).catch((error) => {
        console.error("Sci-Pile batch scan could not continue", error);
      });
    });
  }
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
  await syncPaperpileScanFromJob(job);

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
      permission = originPatternForUrl(candidate.url);
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
  const permissionAttempt = discovery?.attempts?.find(
    (attempt) => attempt?.status === "permission-missing" && attempt.permissionOrigin,
  );
  const permissionOrigin = discovery?.permissionOrigin ?? permissionAttempt?.permissionOrigin ?? null;
  const status = permissionOrigin ? "permission" : discovery?.interaction?.kind ?? "manual";
  let reason = discovery?.interaction?.kind === "permission"
    ? discovery.interaction.reason
    : permissionOrigin
      ? "The displayed page declared a PDF on a website Sci-Pile cannot inspect yet. Allow access to that site to continue."
      : discovery?.interaction?.reason;
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
    permissionOrigin,
  };
  await saveJob(job);
  await syncPaperpileScanFromJob(job);
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
  if (message.type === "skip-batch-interaction") {
    return await skipPaperpileBatchInteraction(job);
  }
  throw new Error("Unknown resolver action.");
}

async function skipPaperpileBatchInteraction(
  job,
  {
    closeTab = true,
    reason = "Skipped without a verified PDF so the batch could continue.",
  } = {},
) {
  if (!isPaperpileBatchInteraction(job)) {
    throw new Error("Only an active Paperpile batch item can be skipped.");
  }

  const tabId = job.interaction?.tabId;
  if (Number.isInteger(tabId)) {
    await unregisterInteractionTab(tabId);
  }
  markPaperpileBatchInteractionSkipped(job, reason);
  await saveJob(job);
  await syncPaperpileScanFromJob(job);

  if (closeTab && Number.isInteger(tabId)) {
    await chrome.tabs.remove(tabId).catch(() => null);
  }
  return { status: "skipped" };
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

  const browserTabUrl = tab.url ?? null;
  const currentUrl = httpUrlFromTab(browserTabUrl) ?? job.interaction.url;
  job.status = "resuming";
  job.interaction.currentUrl = currentUrl;
  job.interaction.error = null;
  job.interaction.permissionOrigin = null;
  await saveJob(job);

  let currentPermissionOrigin = null;
  try {
    currentPermissionOrigin = originPatternForUrl(currentUrl);
  } catch {
    // The subsequent probe provides the useful error for a malformed URL.
  }

  if (
    currentPermissionOrigin &&
    !await chrome.permissions.contains({ origins: [currentPermissionOrigin] })
  ) {
    const resumeAttempt = {
      browserTabUrl,
      requestedUrl: currentUrl,
      finalUrl: null,
      resultKind: null,
      details: null,
      error: "Site access is required for the redirected source.",
      liveInspection: {
        pageUrl: browserTabUrl,
        pageTitle: tab.title ?? null,
        contentType: null,
        candidateCount: 0,
        error: "The displayed page could not be inspected before site access was granted.",
      },
    };
    job.interaction.resumeAttempt = resumeAttempt;
    await setInteractionRequired({
      job,
      url: currentUrl,
      tabId,
      discovery: {
        status: "permission-missing",
        permissionOrigin: currentPermissionOrigin,
        interaction: {
          kind: "permission",
          reason: "The source redirected to a different website. Allow access to the displayed site so Sci-Pile can inspect its standard PDF links.",
        },
      },
      error: null,
    });
    return { status: "permission-required", permissionOrigin: currentPermissionOrigin };
  }

  let liveInspection = {
    pageUrl: browserTabUrl,
    pageTitle: tab.title ?? null,
    contentType: null,
    candidates: [],
  };
  let liveInspectionError = null;
  let tabLoadWarning = null;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: inspectInteractiveSourcePage,
    });
    if (injection?.result && typeof injection.result === "object") {
      liveInspection = injection.result;
    }
  } catch (error) {
    liveInspectionError = errorMessage(error);
  }

  if (
    !liveInspection.candidates?.length &&
    tab.status !== "complete"
  ) {
    try {
      await waitForTabComplete(tabId, 5_000);
    } catch (error) {
      tabLoadWarning = errorMessage(error);
    }

    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: inspectInteractiveSourcePage,
      });
      if (injection?.result && typeof injection.result === "object") {
        liveInspection = injection.result;
        liveInspectionError = null;
      }
    } catch (error) {
      liveInspectionError = errorMessage(error);
    }
  }

  let result = null;
  let probeError = null;
  try {
    result = await probeDocument(currentUrl, { credentials: "include" });
  } catch (error) {
    probeError = errorMessage(error);
  }

  const resumeAttempt = {
    browserTabUrl,
    requestedUrl: currentUrl,
    finalUrl: result?.finalUrl ?? null,
    resultKind: result?.kind ?? null,
    details: result?.diagnostic ?? null,
    error: probeError,
    liveInspection: {
      pageUrl: liveInspection.pageUrl ?? browserTabUrl,
      pageTitle: liveInspection.pageTitle ?? tab.title ?? null,
      contentType: liveInspection.contentType ?? null,
      candidateCount: Array.isArray(liveInspection.candidates)
        ? liveInspection.candidates.length
        : 0,
      error: liveInspectionError,
      loadWarning: tabLoadWarning,
    },
  };
  job.interaction.resumeAttempt = resumeAttempt;

  if (!result && !liveInspection.candidates?.length) {
    await setInteractionRequired({
      job,
      url: currentUrl,
      tabId,
      discovery: {
        status: "inspection-failed",
        error: probeError ?? liveInspectionError ?? "The displayed source could not be inspected.",
      },
      error: probeError ?? liveInspectionError,
    });
    return { status: "interaction-required" };
  }

  if (result?.kind === "pdf") {
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

  const liveCandidates = Array.isArray(liveInspection.candidates)
    ? liveInspection.candidates
    : [];
  let discovery;
  if (result?.kind === "html") {
    discovery = await discoverPdfFromLandingHtml(
      result.html,
      result.finalUrl,
      { credentials: "include", extraCandidates: liveCandidates },
    );
  } else {
    discovery = {
      status: liveCandidates.length ? "checking" : "no-candidates",
      landingUrl: liveInspection.pageUrl ?? currentUrl,
      pageTitle: liveInspection.pageTitle ?? tab.title ?? null,
      candidates: mergePdfCandidates(liveCandidates),
      attempts: [],
    };
    if (discovery.candidates.length) {
      discovery = await verifyPdfCandidates(discovery, { credentials: "include" });
    }
  }
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
    url: result?.finalUrl ?? currentUrl,
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
    isPaperpileBatchInteraction(job) &&
    job.interaction?.tabId === tabId
  ) {
    await skipPaperpileBatchInteraction(job, {
      closeTab: false,
      reason: "The source page was closed without a verified PDF; the batch continued.",
    });
    return;
  }

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
 * Runs inside a page the user explicitly opened. It uses standard metadata
 * plus typed or PDF-labelled embeds, objects, and frames. It does not inspect
 * their contents or use site-specific markup.
 */
function inspectInteractiveSourcePage() {
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

  function looksLikePdfUrl(value) {
    if (typeof value !== "string") {
      return false;
    }
    try {
      const url = new URL(value, location.href);
      return /(?:^|[\/.=_-])pdf(?:$|[?#&/._=-])/i.test(`${url.pathname}${url.search}`);
    } catch {
      return false;
    }
  }

  for (const embed of document.querySelectorAll("embed[src]")) {
    const type = (embed.getAttribute("type") ?? "").split(";", 1)[0].trim().toLowerCase();
    const src = embed.getAttribute("src");
    if (type === "application/pdf" || looksLikePdfUrl(src)) {
      add(src, "embedded PDF");
    }
  }

  for (const object of document.querySelectorAll("object[data]")) {
    const type = (object.getAttribute("type") ?? "").split(";", 1)[0].trim().toLowerCase();
    const data = object.getAttribute("data");
    if (type === "application/pdf" || looksLikePdfUrl(data)) {
      add(data, "PDF object");
    }
  }

  for (const frame of document.querySelectorAll("iframe[src]")) {
    const src = frame.getAttribute("src");
    const description = [frame.id, frame.name, frame.title].filter(Boolean).join(" ");
    if (/\bpdf\b/i.test(description) || looksLikePdfUrl(src)) {
      add(src, "PDF iframe");
    }
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

  return {
    pageUrl: location.href,
    pageTitle: document.title,
    contentType: document.contentType,
    candidates: results.slice(0, 20),
  };
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
  excludePublicationId = null,
  libraryId = PAPERPILE_PERSONAL_LIBRARY_ID,
  requireLibraryMatch = false,
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
      libraryId,
    });

    const duplicate = await waitForPaperpileDuplicate(
      paperpileTab.id,
      lookupPublication,
      PAPERPILE_IMPORT_TIMEOUT_MS,
      excludePublicationId,
      requireLibraryMatch ? libraryId : null,
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

async function findPaperpileDuplicate(
  tabId,
  lookupPublication,
  excludePublicationId = null,
  requiredLibraryId = null,
) {
  const result = await executePaperpileRpc(tabId, "remote.isExistingPub", {
    pub: lookupPublication,
  });
  const duplicates = Array.isArray(result?.duplicates)
    ? result.duplicates.filter((entry) =>
      (entry?.pub?._id ?? entry?.publication_id) !== excludePublicationId &&
      (
        !requiredLibraryId ||
        (entry?.library_id || PAPERPILE_PERSONAL_LIBRARY_ID) === requiredLibraryId
      )
    )
    : [];
  return choosePaperpileDuplicate(duplicates);
}

async function waitForPaperpileDuplicate(
  tabId,
  lookupPublication,
  timeoutMs,
  excludePublicationId = null,
  requiredLibraryId = null,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const duplicate = await findPaperpileDuplicate(
      tabId,
      lookupPublication,
      excludePublicationId,
      requiredLibraryId,
    );
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

async function saveScan(scan) {
  await chrome.storage.session.set({ [`${SCAN_PREFIX}${scan.id}`]: scan });
}

async function getScan(scanId) {
  if (typeof scanId !== "string" || !scanId) {
    return null;
  }
  const key = `${SCAN_PREFIX}${scanId}`;
  const stored = await chrome.storage.session.get(key);
  return stored[key] ?? null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
