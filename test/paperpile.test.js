import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPaperpileImportPublication,
  buildPaperpileLookupPublication,
  classifyPaperpileAttachment,
  choosePaperpileDuplicate,
  getPaperpileAttachmentIds,
  hasPaperpileMainPdf,
  isPaperpileLibraryUrl,
  isPaperpileAutoDownloadEnabled,
  hasPaperpileCollectionIds,
  mergePaperpileCollectionIds,
  paperpileCollectionIds,
} from "../src/lib/paperpile.js";

test("accepts Paperpile library tabs and rejects standalone viewer tabs", () => {
  assert.equal(
    isPaperpileLibraryUrl("https://app.paperpile.com/my-library/all"),
    true,
  );
  assert.equal(
    isPaperpileLibraryUrl("https://app.paperpile.com/my-library/folder?id=example"),
    true,
  );
  assert.equal(
    isPaperpileLibraryUrl("https://app.paperpile.com/view/?id=example"),
    false,
  );
  assert.equal(isPaperpileLibraryUrl("https://paperpile.com/my-library/all"), false);
});

test("builds the typed DOI identifier used by Paperpile duplicate lookup", () => {
  assert.deepEqual(
    buildPaperpileLookupPublication("10.3171/2017.9.JNS1780"),
    {
      doi: "10.3171/2017.9.jns1780",
      id_list: ["doi:10.3171/2017.9.jns1780"],
    },
  );
});

test("builds a DOI-only Paperpile import placeholder", () => {
  assert.deepEqual(
    buildPaperpileImportPublication("10.1000/Example", "publication-id"),
    {
      _id: "publication-id",
      pubtype: "PP_ARTICLE",
      title: "[No title]",
      url: ["https://doi.org/10.1000/example"],
      doi: "10.1000/example",
      id_list: ["doi:10.1000/example"],
    },
  );
});

test("recognizes Paperpile's enabled automatic-PDF setting forms", () => {
  assert.equal(isPaperpileAutoDownloadEnabled({ autoDownloadPDFs: true }), true);
  assert.equal(isPaperpileAutoDownloadEnabled({ autoDownloadPDFs: 1 }), true);
  assert.equal(isPaperpileAutoDownloadEnabled({ autoDownloadPDFs: "1" }), true);
  assert.equal(isPaperpileAutoDownloadEnabled({ autoDownloadPDFs: "true" }), true);
  assert.equal(isPaperpileAutoDownloadEnabled({ autoDownloadPDFs: false }), false);
  assert.equal(isPaperpileAutoDownloadEnabled({ autoDownloadPDFs: 0 }), false);
});

test("prefers a personal-library duplicate", () => {
  const shared = { library_id: "shared", publication_id: "shared-pub" };
  const personal = { library_id: "personal", publication_id: "personal-pub" };
  assert.equal(choosePaperpileDuplicate([shared, personal]), personal);
  assert.equal(choosePaperpileDuplicate([]), null);
});

test("reads attachment ids from Paperpile publication shapes", () => {
  assert.deepEqual(
    getPaperpileAttachmentIds({ attachments: ["one", { _id: "two" }, { id: "three" }] }),
    ["one", "two", "three"],
  );
});

test("detects Paperpile's main-PDF flag", () => {
  assert.equal(hasPaperpileMainPdf({ attachments: [{ article_pdf: 1 }] }), true);
  assert.equal(hasPaperpileMainPdf({ attachments: [{ mimeType: "application/pdf", article_pdf: 0 }] }), false);
  assert.equal(hasPaperpileMainPdf({ attachments: [{ mimeType: "text/plain" }] }), false);
});

test("normalizes, merges, and verifies Paperpile folder and tag ids", () => {
  assert.deepEqual(
    paperpileCollectionIds(["folder-1", { _id: "folder-2" }, { id: "folder-1" }]),
    ["folder-1", "folder-2"],
  );
  assert.deepEqual(
    mergePaperpileCollectionIds(["folder-1"], [{ id: "folder-2" }], ["folder-1"]),
    ["folder-1", "folder-2"],
  );
  assert.equal(
    hasPaperpileCollectionIds(["folder-3", { _id: "folder-1" }], ["folder-1"]),
    true,
  );
  assert.equal(hasPaperpileCollectionIds(["folder-1"], ["folder-2"]), false);
});

test("classifies Paperpile's completed attachment without replacing a main PDF", () => {
  const existingAttachmentIds = new Set(["existing"]);

  assert.equal(classifyPaperpileAttachment({
    attachment: { _id: "existing", article_pdf: 1 },
    existingAttachmentIds,
    hadMainPdf: true,
  }), "already-present");
  assert.equal(classifyPaperpileAttachment({
    attachment: { _id: "new", article_pdf: 0 },
    existingAttachmentIds,
    hadMainPdf: false,
  }), "additional");
  assert.equal(classifyPaperpileAttachment({
    attachment: { _id: "new", article_pdf: 1 },
    existingAttachmentIds,
    hadMainPdf: true,
  }), "main");
});
