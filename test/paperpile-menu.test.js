import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(
  new URL("../src/paperpile/paperpile-menu-core.js", import.meta.url),
  "utf8",
);
const context = vm.createContext({});
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

test("manifest loads the Paperpile menu scripts only on library pages", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../manifest.json", import.meta.url),
    "utf8",
  ));
  const entry = manifest.content_scripts.find((contentScript) =>
    contentScript.matches.includes("https://app.paperpile.com/my-library/*"));

  assert.deepEqual(entry.js, [
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
  assert.match(stylesheet, /\.references/);
});
