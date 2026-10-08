chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen" || message.type !== "parse-landing-html") {
    return false;
  }

  try {
    sendResponse({
      ok: true,
      result: inspectLandingHtml(message.html ?? "", message.baseUrl),
    });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return false;
});

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
