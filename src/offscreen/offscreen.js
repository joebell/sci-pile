chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message?.target !== "offscreen" ||
    !["parse-landing-html", "parse-reference-html"].includes(message.type)
  ) {
    return false;
  }

  try {
    sendResponse({
      ok: true,
      result: message.type === "parse-reference-html"
        ? inspectReferenceHtml(message.html ?? "", message.baseUrl)
        : inspectLandingHtml(message.html ?? "", message.baseUrl),
    });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return false;
});

function inspectReferenceHtml(html, baseUrl) {
  const document = new DOMParser().parseFromString(html, "text/html");
  const metadata = new Map();
  for (const meta of document.querySelectorAll("meta[content]")) {
    const key = (meta.getAttribute("name") ?? meta.getAttribute("property") ?? "")
      .trim()
      .toLowerCase();
    const value = meta.getAttribute("content")?.trim();
    if (!key || !value) {
      continue;
    }
    const values = metadata.get(key) ?? [];
    values.push(value);
    metadata.set(key, values);
  }

  const firstMetadata = (...keys) => {
    for (const key of keys) {
      const value = metadata.get(key)?.find(Boolean);
      if (value) {
        return value;
      }
    }
    return null;
  };
  const allMetadata = (...keys) => keys.flatMap((key) => metadata.get(key) ?? []);
  const doiCandidates = allMetadata(
    "citation_doi",
    "dc.identifier",
    "dc.identifier.doi",
    "dcterms.identifier",
    "prism.doi",
    "eprints.id_number",
    "article_doi",
  );
  const jsonLdMetadata = { dois: [], titles: [], authors: [], containers: [], dates: [] };

  function addJsonLdValue(output, value) {
    for (const candidate of [value].flat()) {
      if (typeof candidate === "string" && candidate.trim()) {
        output.push(candidate.trim());
      }
    }
  }

  function visitJsonLd(node, depth = 0) {
    if (depth > 12 || node === null || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) {
        visitJsonLd(entry, depth + 1);
      }
      return;
    }

    addJsonLdValue(jsonLdMetadata.dois, node.doi);
    addJsonLdValue(jsonLdMetadata.dois, node.identifier);
    if (/doi/i.test(String(node.propertyID ?? node.propertyId ?? ""))) {
      addJsonLdValue(jsonLdMetadata.dois, node.value);
      addJsonLdValue(jsonLdMetadata.dois, node.name);
    }
    addJsonLdValue(jsonLdMetadata.dois, node.sameAs);
    addJsonLdValue(jsonLdMetadata.dois, node.url);
    addJsonLdValue(jsonLdMetadata.titles, node.headline);
    addJsonLdValue(jsonLdMetadata.titles, node.name);
    addJsonLdValue(jsonLdMetadata.dates, node.datePublished);
    addJsonLdValue(jsonLdMetadata.dates, node.dateCreated);
    addJsonLdValue(jsonLdMetadata.containers, node.isPartOf?.name);
    for (const author of [node.author].flat()) {
      if (typeof author === "string") {
        addJsonLdValue(jsonLdMetadata.authors, author);
      } else if (author && typeof author === "object") {
        addJsonLdValue(jsonLdMetadata.authors, author.name);
      }
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

  for (const link of document.querySelectorAll('a[href*="doi.org/" i], link[href*="doi.org/" i]')) {
    doiCandidates.push(link.getAttribute("href"));
  }
  doiCandidates.push(...jsonLdMetadata.dois, baseUrl);

  const doi = doiCandidates.map(extractDoi).find(Boolean) ?? null;
  const title = cleanText(
    firstMetadata("citation_title", "dc.title", "dcterms.title", "og:title") ??
    jsonLdMetadata.titles[0] ??
    document.title,
    1_000,
  ) || null;
  const authors = [
    ...allMetadata("citation_author", "dc.creator", "dcterms.creator"),
    ...jsonLdMetadata.authors,
  ].map((value) => cleanText(value, 300)).filter(Boolean).slice(0, 8);
  const container = cleanText(
    firstMetadata("citation_journal_title", "citation_conference_title", "prism.publicationname") ??
    jsonLdMetadata.containers[0],
    500,
  );
  const date = firstMetadata(
    "citation_publication_date",
    "citation_date",
    "dc.date",
    "dcterms.issued",
    "article:published_time",
  ) ?? jsonLdMetadata.dates[0] ?? "";
  const yearMatch = String(date).match(/\b(?:19|20)\d{2}\b/);

  return {
    doi,
    title,
    citation: [...new Set([...authors, container].filter(Boolean))].join(" - "),
    year: yearMatch ? Number(yearMatch[0]) : null,
  };
}

function extractDoi(value) {
  if (typeof value !== "string") {
    return null;
  }
  let candidate = value.trim();
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    // The original value may still contain a DOI.
  }
  const match = candidate.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  if (!match) {
    return null;
  }
  let doi = match[0].replace(/[.,;:!?]+$/, "");
  while (doi.endsWith(")") && countCharacter(doi, ")") > countCharacter(doi, "(")) {
    doi = doi.slice(0, -1).replace(/[.,;:!?]+$/, "");
  }
  return doi || null;
}

function countCharacter(value, character) {
  return [...value].filter((candidate) => candidate === character).length;
}

function cleanText(value, limit) {
  return typeof value === "string"
    ? value.replace(/[\u200b-\u200f\u2060\ufeff]/g, "").replace(/\s+/g, " ").trim().slice(0, limit)
    : "";
}

function inspectLandingHtml(html, baseUrl) {
  const document = new DOMParser().parseFromString(html, "text/html");
  const candidates = [];
  const seen = new Set();

  function add(value, source) {
    if (typeof value !== "string" || !value.trim()) {
      return;
    }

    try {
      const url = new URL(value.trim(), baseUrl);
      if (!["https:", "http:"].includes(url.protocol) || seen.has(url.href)) {
        return;
      }
      seen.add(url.href);
      candidates.push({ url: url.href, source });
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

  const challengeElement = document.querySelector([
    '[id*="captcha" i]',
    '[class*="captcha" i]',
    'iframe[src*="recaptcha" i]',
    'iframe[src*="hcaptcha" i]',
    'iframe[src*="challenges.cloudflare.com" i]',
    '[class*="turnstile" i]',
  ].join(","));
  const loginElement = document.querySelector([
    'input[type="password"]',
    'form[action*="login" i]',
    'form[action*="signin" i]',
    'form[action*="sign-in" i]',
  ].join(","));
  const visibleText = `${document.title ?? ""} ${document.body?.textContent ?? ""}`
    .replace(/\s+/g, " ")
    .slice(0, 50_000);
  const challengeText = /captcha|verify (?:that )?you are human|checking your browser|security check|challenge required/i.test(visibleText);
  const loginText = /\b(?:sign in|log in|institutional login|authentication required)\b/i.test(visibleText);

  let interaction = null;
  if (challengeElement || challengeText) {
    interaction = {
      kind: "challenge",
      reason: "The source appears to require a CAPTCHA or browser-verification step.",
    };
  } else if (loginElement || loginText) {
    interaction = {
      kind: "login",
      reason: "The source appears to require sign-in or institutional authentication.",
    };
  }

  return {
    candidates: candidates.slice(0, 20),
    interaction,
    title: document.title?.trim().slice(0, 300) || null,
  };
}
