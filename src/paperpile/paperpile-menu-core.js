(function installPaperpileMenuCore(root) {
  "use strict";

  const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
  const REQUIRED_MENU_LABELS = [
    "Find PDF online",
    "Attach PDF…",
    "Browse for PDF…",
    "Search Google for PDF…",
  ];
  const REQUIRED_MAIN_MENU_LABELS = [
    "Auto update",
    "Find PDFs online",
    "Make a copy",
    "Export…",
  ];

  function normalizeLabel(value) {
    return typeof value === "string"
      ? value.trim().replace(/\s+/g, " ").replace(/\.\.\./g, "…")
      : "";
  }

  function normalizeDoi(value) {
    if (typeof value !== "string") {
      return null;
    }

    let candidate = value.trim();
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      // The unescaped value may still contain a valid DOI.
    }

    candidate = candidate
      .replace(/^doi\s*:\s*/i, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");

    const match = candidate.match(DOI_PATTERN);
    if (!match) {
      return null;
    }

    let doi = match[0].replace(/[.,;:!?]+$/, "");
    for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      while (
        doi.endsWith(closing) &&
        [...doi].filter((character) => character === closing).length >
          [...doi].filter((character) => character === opening).length
      ) {
        doi = doi.slice(0, -1).replace(/[.,;:!?]+$/, "");
      }
    }
    return doi || null;
  }

  function findDoiInValues(values) {
    for (const value of values ?? []) {
      const doi = normalizeDoi(value);
      if (doi) {
        return doi;
      }
    }
    return null;
  }

  function isPaperpilePdfMenu(labels) {
    const available = new Set((labels ?? []).map(normalizeLabel));
    return REQUIRED_MENU_LABELS.every((label) => available.has(label));
  }

  function isPaperpileMainMenu(labels) {
    const available = new Set((labels ?? []).map(normalizeLabel));
    return REQUIRED_MAIN_MENU_LABELS.every((label) => available.has(label));
  }

  function cleanReferenceText(value) {
    return typeof value === "string"
      ? value.replace(/[\u200b-\u200f\u2060\ufeff]/g, "").trim().replace(/\s+/g, " ")
      : "";
  }

  function referenceYear(value) {
    const match = cleanReferenceText(value).match(/\b(?:19|20)\d{2}\b/);
    return match ? Number(match[0]) : null;
  }

  root.SciPilePaperpileMenuCore = Object.freeze({
    findDoiInValues,
    cleanReferenceText,
    isPaperpileMainMenu,
    isPaperpilePdfMenu,
    normalizeDoi,
    normalizeLabel,
    referenceYear,
  });
})(globalThis);
