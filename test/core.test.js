import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCandidateUrl,
  encodeDoiForUrl,
  filenameForDoi,
  findFirstDoi,
  hasHtmlSignature,
  hasPdfSignature,
  httpUrlFromTab,
  normalizeDoi,
  originPattern,
  validatePrefix,
} from "../src/lib/core.js";

test("normalizes a DOI URL", () => {
  assert.equal(
    normalizeDoi("https://doi.org/10.1038/s41586-020-2649-2"),
    "10.1038/s41586-020-2649-2",
  );
});

test("removes prose punctuation and an unmatched closing parenthesis", () => {
  assert.equal(normalizeDoi("10.1000/example)."), "10.1000/example");
});

test("preserves balanced parentheses that belong to a DOI", () => {
  assert.equal(normalizeDoi("10.1002/(SICI)1234-5678(199901)1:1<1::AID-X>3.0.CO;2-1"), "10.1002/(SICI)1234-5678(199901)1:1");
});

test("finds the first DOI from the first matching value", () => {
  assert.equal(
    findFirstDoi("First 10.1111/alpha then 10.2222/beta", "10.3333/gamma"),
    "10.1111/alpha",
  );
});

test("unwraps HTTP URLs from Chromium's PDF viewer", () => {
  assert.equal(
    httpUrlFromTab("chrome-extension://viewer/index.html?file=https%3A%2F%2Fexample.org%2Fpaper.pdf"),
    "https://example.org/paper.pdf",
  );
  assert.equal(httpUrlFromTab("https://example.org/paper.pdf"), "https://example.org/paper.pdf");
  assert.equal(httpUrlFromTab("blob:https://example.org/id"), null);
});

test("encodes DOI components while preserving slash separators", () => {
  assert.equal(
    encodeDoiForUrl("10.1000/example(1):part"),
    "10.1000/example(1)%3Apart",
  );
});

test("appends the encoded DOI directly to a prefix", () => {
  assert.equal(
    buildCandidateUrl("https://example.org/pdf/", "10.1000/example:one"),
    "https://example.org/pdf/10.1000/example%3Aone",
  );
});

test("supports a query-style prefix", () => {
  assert.equal(
    buildCandidateUrl("https://example.org/find?doi=", "10.1000/example"),
    "https://example.org/find?doi=10.1000/example",
  );
});

test("rejects non-HTTP prefixes and URL credentials", () => {
  assert.throws(() => validatePrefix("file:///tmp/"), /HTTPS or HTTP/);
  assert.throws(() => validatePrefix("https://user:pass@example.org/"), /Credentials/);
});

test("creates a host permission pattern", () => {
  assert.equal(
    originPattern("https://example.org:8443/pdf/"),
    "https://example.org:8443/*",
  );
});

test("creates a safe PDF filename from a DOI", () => {
  assert.equal(
    filenameForDoi("10.3171/2017.9.JNS1780"),
    "10.3171_2017.9.JNS1780.pdf",
  );
  assert.equal(
    filenameForDoi("10.1000/example:one?two"),
    "10.1000_example_one.pdf",
  );
});

test("recognizes a PDF signature within the first bytes", () => {
  const bytes = new TextEncoder().encode("\uFEFF%PDF-1.7\n");
  assert.equal(hasPdfSignature(bytes), true);
  assert.equal(hasPdfSignature(new TextEncoder().encode("<!doctype html>")), false);
});

test("recognizes an HTML document signature", () => {
  assert.equal(hasHtmlSignature(new TextEncoder().encode("  <!DOCTYPE html><html>")), true);
  assert.equal(hasHtmlSignature(new TextEncoder().encode("<html><head></head>")), true);
  assert.equal(hasHtmlSignature(new TextEncoder().encode("%PDF-1.7")), false);
});
