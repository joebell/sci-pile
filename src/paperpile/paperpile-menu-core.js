(function installPaperpileMenuCore(root) {
  "use strict";

  const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
  const REQUIRED_MENU_LABELS = [
    "Find PDF online",
    "Attach PDF…",
    "Browse for PDF…",
    "Search Google for PDF…",
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

  root.SciPilePaperpileMenuCore = Object.freeze({
    findDoiInValues,
    isPaperpilePdfMenu,
    normalizeDoi,
    normalizeLabel,
  });
})(globalThis);
