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

  function selectedReferenceCount(value) {
    const text = typeof value === "string" ? value : "";
    const match = text.match(/\b([\d,]+)\s+references?\s*[·\u00b7]\s*([\d,]+)\s+selected\b/i) ??
      text.match(/\b([\d,]+)\s+selected\b/i);
    if (!match) {
      return null;
    }
    const selected = Number((match[2] ?? match[1]).replace(/,/g, ""));
    return Number.isSafeInteger(selected) && selected >= 0 ? selected : null;
  }

  function referenceFromPaperpileExport(reference) {
    if (!reference || typeof reference !== "object") {
      return null;
    }

    const title = cleanReferenceText(reference.title ?? reference._title) ||
      "[Untitled Paperpile reference]";

    const identifierValues = [];
    collectStrings(reference.doi, identifierValues);
    collectStrings(reference.id_list, identifierValues);
    collectStrings(reference.url, identifierValues);

    const authorList = Array.isArray(reference.author)
      ? reference.author
      : Array.isArray(reference.authors)
        ? reference.authors
        : [];
    const authors = authorList
      .map((author) => {
        if (typeof author === "string") {
          return cleanReferenceText(author);
        }
        return cleanReferenceText(
          author?.literal ?? author?.name ??
          [author?.last ?? author?.family, author?.first ?? author?.given]
            .filter(Boolean)
            .join(", "),
        );
      })
      .filter(Boolean)
      .slice(0, 5)
      .join(", ");
    const container = cleanReferenceText(
      reference.journal ?? reference.publisher ?? reference.container_title ?? reference._journal,
    );
    const year = referenceYear([
      reference.year,
      reference.published,
      reference.date,
      reference._date,
    ].filter(Boolean).join(" "));

    return {
      paperpileId: cleanReferenceText(reference._id ?? reference.id),
      title,
      citation: [authors, container].filter(Boolean).join(" - "),
      year,
      doi: findDoiInValues(identifierValues),
      hasPdf: hasAttachedPdf(reference),
    };
  }

  function hasAttachedPdf(reference) {
    return Array.isArray(reference?.attachments) && reference.attachments.some((attachment) =>
      attachment && typeof attachment === "object" && Number(attachment.article_pdf) === 1
    );
  }

  function collectStrings(value, output, depth = 0) {
    if (typeof value === "string") {
      output.push(value);
      return;
    }
    if (!value || depth >= 3) {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        collectStrings(entry, output, depth + 1);
      }
      return;
    }
    if (typeof value === "object") {
      for (const entry of Object.values(value)) {
        collectStrings(entry, output, depth + 1);
      }
    }
  }

  root.SciPilePaperpileMenuCore = Object.freeze({
    findDoiInValues,
    cleanReferenceText,
    isPaperpileMainMenu,
    isPaperpilePdfMenu,
    normalizeDoi,
    normalizeLabel,
    referenceFromPaperpileExport,
    referenceYear,
    selectedReferenceCount,
  });
})(globalThis);
