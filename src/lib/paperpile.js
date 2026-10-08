import { normalizeDoi } from "./core.js";

export const PAPERPILE_PERSONAL_LIBRARY_ID = "personal";

export function isPaperpileLibraryUrl(value) {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "app.paperpile.com" &&
      (url.pathname === "/my-library" || url.pathname.startsWith("/my-library/"));
  } catch {
    return false;
  }
}

/**
 * Paperpile's duplicate index uses lower-case typed identifiers.
 */
export function buildPaperpileLookupPublication(doi) {
  const normalized = normalizeDoi(doi);
  if (!normalized) {
    throw new Error("Invalid DOI");
  }

  const canonicalDoi = normalized.toLowerCase();
  return {
    doi: canonicalDoi,
    id_list: [`doi:${canonicalDoi}`],
  };
}

/**
 * A DOI-only placeholder for Paperpile's own autocomplete/import pipeline.
 * Paperpile replaces the placeholder fields with its matched metadata before
 * inserting the reference.
 */
export function buildPaperpileImportPublication(doi, id) {
  if (typeof id !== "string" || !id) {
    throw new Error("A publication id is required");
  }

  const lookup = buildPaperpileLookupPublication(doi);
  return {
    _id: id,
    pubtype: "PP_ARTICLE",
    title: "[No title]",
    url: [`https://doi.org/${lookup.doi}`],
    ...lookup,
  };
}

/** Paperpile has stored this preference as booleans, numbers, and strings. */
export function isPaperpileAutoDownloadEnabled(user) {
  const value = user?.autoDownloadPDFs;
  return value === true || value === 1 || value === "1" || value === "true";
}

/** Prefer the personal-library record when the DOI exists in several places. */
export function choosePaperpileDuplicate(duplicates) {
  if (!Array.isArray(duplicates) || duplicates.length === 0) {
    return null;
  }

  return duplicates.find((entry) =>
    !entry?.library_id || entry.library_id === PAPERPILE_PERSONAL_LIBRARY_ID
  ) ?? duplicates[0];
}

export function getPaperpileAttachmentIds(publication) {
  if (!Array.isArray(publication?.attachments)) {
    return [];
  }

  return publication.attachments
    .map((attachment) => {
      if (typeof attachment === "string") {
        return attachment;
      }
      return attachment?._id ?? attachment?.id ?? null;
    })
    .filter(Boolean);
}

export function hasPaperpileMainPdf(publication) {
  return Array.isArray(publication?.attachments) && publication.attachments.some((attachment) => {
    if (!attachment || typeof attachment !== "object") {
      return false;
    }
    return Number(attachment.article_pdf) === 1;
  });
}

/**
 * Prefer Paperpile's returned attachment flag over the pre-import snapshot.
 * The duplicate lookup may return attachment ids without their article_pdf
 * fields, while the completed crawl event includes the inserted attachment.
 */
export function classifyPaperpileAttachment({
  attachment,
  existingAttachmentIds,
  hadMainPdf,
}) {
  if (!attachment) {
    return "pending";
  }

  const attachmentId = attachment._id ?? attachment.id ?? null;
  if (attachmentId && existingAttachmentIds?.has(attachmentId)) {
    return "already-present";
  }

  if (Number(attachment.article_pdf) === 0) {
    return "additional";
  }
  if (Number(attachment.article_pdf) === 1) {
    return "main";
  }

  return hadMainPdf ? "additional" : "main";
}
