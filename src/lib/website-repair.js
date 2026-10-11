const REPEATED_SCHEME_HOST = /^(?:https?)+$/i;
const SCHEME_PREFIX = /^(?:https?)+(?::)?\/{1,2}/i;
const PII_PATTERN = /\bS\d{16}\b/gi;
const GENERIC_PATH_WORDS = new Set([
  "abstract",
  "article",
  "articles",
  "doi",
  "full",
  "fulltext",
  "html",
  "journal",
  "journals",
  "pdf",
  "pii",
  "retrieve",
  "showall",
]);

export function analyzeWebsiteRepairUrl(value) {
  const originalUrl = typeof value === "string" ? value.trim() : "";
  const repaired = repairMalformedWebsiteUrl(originalUrl);
  const searchable = [originalUrl, repaired.url].filter(Boolean).join(" ");
  const alternativeIds = [...new Set(searchable.match(PII_PATTERN) ?? [])]
    .map((identifier) => identifier.toUpperCase());
  const titleHint = titleHintFromUrl(repaired.url ?? originalUrl);
  const searchQuery = (
    alternativeIds[0] ?? titleHint ?? repaired.url ?? originalUrl
  ) || null;

  return {
    originalUrl: originalUrl || null,
    url: repaired.url,
    changed: repaired.changed,
    repairReason: repaired.reason,
    alternativeIds,
    titleHint,
    searchQuery,
  };
}

export function repairMalformedWebsiteUrl(value) {
  const original = typeof value === "string" ? value.trim() : "";
  if (!original) {
    return { url: null, changed: false, reason: null };
  }

  try {
    const parsed = new URL(original);
    if (
      ["http:", "https:"].includes(parsed.protocol) &&
      !REPEATED_SCHEME_HOST.test(parsed.hostname)
    ) {
      return { url: parsed.href, changed: parsed.href !== original, reason: null };
    }
  } catch {
    // Try the narrowly scoped repeated/broken scheme repair below.
  }

  let remainder = original;
  let removed = false;
  while (SCHEME_PREFIX.test(remainder)) {
    remainder = remainder.replace(SCHEME_PREFIX, "");
    removed = true;
  }
  remainder = remainder.replace(/^\/+/, "");
  if (!removed || !/^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(remainder)) {
    return { url: null, changed: false, reason: null };
  }

  try {
    const repaired = new URL(`https://${remainder}`);
    return {
      url: repaired.href,
      changed: repaired.href !== original,
      reason: "Removed duplicated or malformed HTTP/HTTPS scheme text.",
    };
  } catch {
    return { url: null, changed: false, reason: null };
  }
}

export function titleHintFromUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const candidates = parsed.pathname
    .split("/")
    .map(safeDecode)
    .map((segment) => segment.replace(/\.[a-z0-9]{1,6}$/i, ""))
    .map((segment) => segment.replace(/[^\p{L}\p{N}]+/gu, " "))
    .map((segment) => segment.replace(/\b\d+\b/g, " ").replace(/\s+/g, " ").trim())
    .map((segment) => segment
      .split(" ")
      .filter((word) => word.length > 2 && !GENERIC_PATH_WORDS.has(word.toLowerCase()))
      .join(" "))
    .filter((segment) => segment.split(" ").length >= 4)
    .sort((left, right) => right.length - left.length);
  return candidates[0]?.slice(0, 500) ?? null;
}

export function googleScholarSearchUrl(query) {
  const clean = typeof query === "string" ? query.trim().replace(/\s+/g, " ") : "";
  if (!clean) {
    return null;
  }
  const url = new URL("https://scholar.google.com/scholar");
  url.searchParams.set("q", clean.slice(0, 1_000));
  return url.href;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
