const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;

const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

function countCharacter(value, character) {
  return [...value].filter((item) => item === character).length;
}

/**
 * Normalize a DOI or DOI URL and remove punctuation that commonly follows a
 * DOI in prose. DOI case is preserved for display and URL construction.
 */
export function normalizeDoi(value) {
  if (typeof value !== "string") {
    return null;
  }

  const withoutPrefix = value
    .trim()
    .replace(/^doi\s*:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");

  const match = withoutPrefix.match(DOI_PATTERN);
  if (!match) {
    return null;
  }

  let doi = match[0].replace(TRAILING_PUNCTUATION, "");

  const pairs = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ];

  for (const [opening, closing] of pairs) {
    while (
      doi.endsWith(closing) &&
      countCharacter(doi, closing) > countCharacter(doi, opening)
    ) {
      doi = doi.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
    }
  }

  return doi || null;
}

export function findFirstDoi(...values) {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const match = value.match(DOI_PATTERN);
    if (match) {
      return normalizeDoi(match[0]);
    }
  }

  return null;
}

/**
 * Return a directly fetchable URL from a browser tab. Chromium's built-in PDF
 * viewer wraps the original URL in its `file` query parameter.
 */
export function httpUrlFromTab(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (["https:", "http:"].includes(url.protocol)) {
    return url.href;
  }

  for (const parameter of ["file", "url", "src"]) {
    const wrapped = url.searchParams.get(parameter);
    if (!wrapped) {
      continue;
    }
    try {
      const candidate = new URL(wrapped);
      if (["https:", "http:"].includes(candidate.protocol)) {
        return candidate.href;
      }
    } catch {
      // Ignore malformed viewer parameters.
    }
  }
  return null;
}

/** Encode DOI path components without removing the DOI's slash separators. */
export function encodeDoiForUrl(doi) {
  const normalized = normalizeDoi(doi);
  if (!normalized) {
    throw new Error("Invalid DOI");
  }

  return normalized.split("/").map(encodeURIComponent).join("/");
}

export function validatePrefix(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Enter a URL prefix.");
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid absolute URL prefix.");
  }

  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error("The prefix must use HTTPS or HTTP.");
  }

  if (url.username || url.password) {
    throw new Error("Credentials are not allowed in a URL prefix.");
  }

  if (url.hash) {
    throw new Error("Remove the URL fragment (#...) from the prefix.");
  }

  return url.href;
}

export function buildCandidateUrl(prefix, doi) {
  const normalizedPrefix = validatePrefix(prefix);
  return new URL(`${normalizedPrefix}${encodeDoiForUrl(doi)}`).href;
}

export function originPattern(prefix) {
  const url = new URL(validatePrefix(prefix));
  return `${url.protocol}//${url.host}/*`;
}

/** Return a host permission pattern for a resolved page or asset URL. */
export function originPatternForUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid absolute URL.");
  }

  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("The URL must use HTTPS or HTTP.");
  }
  if (url.username || url.password) {
    throw new Error("Credentials are not allowed in a URL.");
  }

  return `${url.protocol}//${url.host}/*`;
}

export function filenameForDoi(doi) {
  const normalized = normalizeDoi(doi);
  if (!normalized) {
    throw new Error("Invalid DOI");
  }

  const safeStem = normalized
    .normalize("NFKC")
    .replace(/[^A-Z0-9._-]+/gi, "_")
    .replace(/^[_\.]+|[_\.]+$/g, "")
    .slice(0, 180);

  return `${safeStem || "article"}.pdf`;
}

export function hasPdfSignature(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    return false;
  }

  const signature = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  for (let offset = 0; offset <= bytes.length - signature.length; offset += 1) {
    if (signature.every((byte, index) => bytes[offset + index] === byte)) {
      return true;
    }
  }
  return false;
}

export function hasHtmlSignature(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    return false;
  }

  const text = new TextDecoder("utf-8")
    .decode(bytes.slice(0, 1024))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();

  return text.startsWith("<!doctype html") || text.startsWith("<html");
}
