import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(
  new URL("../src/paperpile/paperpile-menu-core.js", import.meta.url),
  "utf8",
);
const context = vm.createContext({ URL });
vm.runInContext(source, context);
const core = context.SciPilePaperpileMenuCore;

test("finds a DOI in the selected Paperpile reference links", () => {
  assert.equal(
    core.findDoiInValues([
      "https://www.ncbi.nlm.nih.gov/pubmed/42048292",
      "https://doi.org/10.1159/000552017",
    ]),
    "10.1159/000552017",
  );
});

test("decodes DOI URLs and removes trailing prose punctuation", () => {
  assert.equal(
    core.findDoiInValues(["https://doi.org/10.1000%2Fexample)."]),
    "10.1000/example",
  );
});

test("recognizes only Paperpile's complete Add PDF menu", () => {
  assert.equal(core.isPaperpilePdfMenu([
    "Find PDF online",
    "Attach PDF...",
    "Browse for PDF...",
    "Search Google for PDF...",
  ]), true);
  assert.equal(core.isPaperpilePdfMenu([
    "Find PDF online",
    "Attach PDF...",
  ]), false);
});

test("recognizes Paperpile's main reference-actions menu", () => {
  assert.equal(core.isPaperpileMainMenu([
    "Folders...",
    "Auto update",
    "Find PDFs online",
    "Make a copy",
    "Export...",
  ]), true);
  assert.equal(core.isPaperpileMainMenu([
    "Find PDF online",
    "Attach PDF...",
    "Browse for PDF...",
    "Search Google for PDF...",
  ]), false);
});

test("cleans Paperpile title markers and extracts a plausible year", () => {
  assert.equal(
    core.cleanReferenceText("  A title \u2060 \u2060 with   spacing  "),
    "A title with spacing",
  );
  assert.equal(core.referenceYear("Neuron · 2024 · Journal article"), 2024);
  assert.equal(core.referenceYear("No date"), null);
});

test("reads Paperpile's complete selected-reference count", () => {
  assert.equal(core.selectedReferenceCount("336 references · 336 selected"), 336);
  assert.equal(core.selectedReferenceCount("1,940 references · 1,202 selected"), 1202);
  assert.equal(core.selectedReferenceCount("No selection"), null);
});

test("normalizes Paperpile JSON exports and detects an attached main PDF", () => {
  const reference = core.referenceFromPaperpileExport({
    _id: "paper-1",
    title: " A selected paper ",
    author: [{ first: "Ada", last: "Lovelace" }],
    journal: "Journal of Tests",
    year: "2024",
    doi: "https://doi.org/10.1000/example",
    attachments: [{ _id: "pdf-1", article_pdf: 1, mimeType: "application/pdf" }],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(reference)), {
    paperpileId: "paper-1",
    title: "A selected paper",
    citation: "Lovelace, Ada - Journal of Tests",
    year: 2024,
    doi: "10.1000/example",
    hasPdf: true,
    pubtype: "",
    urls: [],
    folders: [],
    labels: [],
    libraryId: "personal",
  });
});

test("preserves Website links, library, folders, and tags from Paperpile exports", () => {
  const reference = core.referenceFromPaperpileExport({
    _id: "website-1",
    pubtype: "PP_WEBSITE",
    title: "Publisher page",
    url: ["www.example.org/article", "publisher.example.net/paper", "javascript:alert(1)"],
    folders: [{ _id: "folder-1" }],
    labels: ["label-1", { id: "label-2" }],
    tags: [{ _id: "label-3" }],
    library_id: "shared-library",
  });

  assert.deepEqual(JSON.parse(JSON.stringify(reference)), {
    paperpileId: "website-1",
    title: "Publisher page",
    citation: "",
    year: null,
    doi: null,
    hasPdf: false,
    pubtype: "PP_WEBSITE",
    urls: ["https://www.example.org/article", "https://publisher.example.net/paper"],
    folders: ["folder-1"],
    labels: ["label-1", "label-2", "label-3"],
    libraryId: "shared-library",
  });
});

test("manifest loads the Paperpile menu scripts only on library pages", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../manifest.json", import.meta.url),
    "utf8",
  ));
  const entry = manifest.content_scripts.find((contentScript) =>
    contentScript.matches.includes("https://app.paperpile.com/my-library/*"));

  assert.deepEqual(entry.js, ["src/paperpile/paperpile-export-bridge.js"]);
  assert.equal(entry.world, "MAIN");
  assert.equal(entry.run_at, "document_start");

  const menuEntry = manifest.content_scripts.find((contentScript) =>
    contentScript.matches.includes("https://app.paperpile.com/my-library/*") &&
    contentScript.world !== "MAIN");

  assert.deepEqual(menuEntry.js, [
    "src/paperpile/paperpile-menu-core.js",
    "src/paperpile/paperpile-menu.js",
  ]);
});

test("batch review page is packaged with its module and stylesheet", async () => {
  const [html, script, stylesheet] = await Promise.all([
    readFile(new URL("../src/batch/batch.html", import.meta.url), "utf8"),
    readFile(new URL("../src/batch/batch.js", import.meta.url), "utf8"),
    readFile(new URL("../src/batch/batch.css", import.meta.url), "utf8"),
  ]);

  assert.match(html, /Download and attach selected PDFs/);
  assert.match(html, /batch\.js/);
  assert.match(html, /batch\.css/);
  assert.match(script, /start-paperpile-scan/);
  assert.match(script, /start-paperpile-repair/);
  assert.match(script, /retry-paperpile-repair-identification/);
  assert.match(stylesheet, /\.references/);
});

test("Paperpile menu includes the Website repair command", async () => {
  const source = await readFile(
    new URL("../src/paperpile/paperpile-menu.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /Repair Website references with sci-pile/);
  assert.match(source, /create-paperpile-repair/);
});

test("offscreen parser supports scholarly reference metadata", async () => {
  const source = await readFile(
    new URL("../src/offscreen/offscreen.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /parse-reference-html/);
  assert.match(source, /citation_doi/);
  assert.match(source, /application\/ld\+json/);
});
