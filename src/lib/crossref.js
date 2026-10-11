import { normalizeDoi } from "./core.js";

export const CROSSREF_WORKS_URL = "https://api.crossref.org/works";
export const DEFAULT_CROSSREF_TIMEOUT_MS = 12_000;

export async function resolveDoiFromBibliographicMetadata(
  metadata,
  {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_CROSSREF_TIMEOUT_MS,
  } = {},
) {
  const title = cleanText(metadata?.title);
  if (!title) {
    throw new Error("This bibliographic record does not include a usable title.");
  }

  const citation = cleanText(metadata?.citation);
  const query = [title, citation].filter(Boolean).join(" ");
  const url = new URL(CROSSREF_WORKS_URL);
  url.searchParams.set("query.bibliographic", query);
  url.searchParams.set("rows", "5");
  url.searchParams.set(
    "select",
    "DOI,title,author,issued,score",
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url.href, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Crossref DOI lookup timed out.");
    }
    throw new Error(`Crossref DOI lookup failed: ${errorMessage(error)}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`Crossref DOI lookup returned HTTP ${response.status}.`);
  }

  const payload = await response.json();
  const items = Array.isArray(payload?.message?.items)
    ? payload.message.items
    : [];
  const scholarYear = Number.isInteger(metadata?.year) ? metadata.year : null;
  const scholarAuthorTokens = authorTokens(metadata?.citation);

  const candidates = items
    .map((item) => scoreCandidate(item, {
      title,
      scholarYear,
      scholarAuthorTokens,
    }))
    .filter((candidate) => candidate.doi)
    .sort((left, right) => right.confidence - left.confidence);

  const best = candidates[0];
  if (!best || !best.accepted) {
    throw new Error(
      "No unambiguous DOI match was found for this bibliographic record.",
    );
  }

  return {
    doi: best.doi,
    match: {
      title: best.title,
      titleSimilarity: best.titleSimilarity,
      authorCompared: best.authorCompared,
      authorMatched: best.authorMatched,
      year: best.year,
      yearCompared: best.yearCompared,
      yearMatched: best.yearMatched,
    },
  };
}

export function titleSimilarity(left, right) {
  const leftTokens = normalizedTokens(left);
  const rightTokens = normalizedTokens(right);
  if (!leftTokens.length || !rightTokens.length) {
    return 0;
  }

  const leftCounts = tokenCounts(leftTokens);
  const rightCounts = tokenCounts(rightTokens);
  let overlap = 0;
  for (const [token, count] of leftCounts) {
    overlap += Math.min(count, rightCounts.get(token) ?? 0);
  }
  return (2 * overlap) / (leftTokens.length + rightTokens.length);
}

function scoreCandidate(item, { title, scholarYear, scholarAuthorTokens }) {
  const candidateTitle = cleanText(item?.title?.[0]);
  const doi = normalizeDoi(item?.DOI);
  const similarity = titleSimilarity(title, candidateTitle);
  const year = crossrefYear(item);
  const yearMatched = scholarYear === null || year === null ||
    Math.abs(scholarYear - year) <= 1;
  const candidateAuthors = new Set(
    (item?.author ?? [])
      .flatMap((author) => normalizedTokens(author?.family))
      .filter((token) => token.length > 2),
  );
  const authorCompared = scholarAuthorTokens.size > 0 && candidateAuthors.size > 0;
  const authorMatched = !authorCompared ||
    [...candidateAuthors].some((token) => scholarAuthorTokens.has(token));
  const yearCompared = scholarYear !== null && year !== null;
  const exactTitle = normalizedText(title) === normalizedText(candidateTitle);
  const accepted = Boolean(doi) && yearMatched && (
    exactTitle ||
    similarity >= 0.94 ||
    (
      similarity >= 0.86 &&
      authorCompared &&
      authorMatched &&
      yearCompared
    )
  );
  const confidence = similarity +
    (exactTitle ? 0.25 : 0) +
    (yearMatched ? 0.05 : -0.3) +
    (authorMatched ? 0.05 : -0.15);

  return {
    doi,
    title: candidateTitle,
    titleSimilarity: Number(similarity.toFixed(3)),
    year,
    yearCompared,
    yearMatched,
    authorCompared,
    authorMatched,
    accepted,
    confidence,
  };
}

function crossrefYear(item) {
  for (const field of ["published-print", "published-online", "published", "issued"]) {
    const year = item?.[field]?.["date-parts"]?.[0]?.[0];
    if (Number.isInteger(year)) {
      return year;
    }
  }
  return null;
}

function authorTokens(citation) {
  const authorSegment = cleanText(citation).split(/\s+-\s+/, 1)[0];
  return new Set(
    normalizedTokens(authorSegment).filter((token) => token.length > 2),
  );
}

function tokenCounts(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function normalizedTokens(value) {
  return normalizedText(value).split(" ").filter(Boolean);
}

function normalizedText(value) {
  return cleanText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function cleanText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
