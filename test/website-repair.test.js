import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeWebsiteRepairUrl,
  googleScholarSearchUrl,
  repairMalformedWebsiteUrl,
  titleHintFromUrl,
} from "../src/lib/website-repair.js";

test("repairs repeated malformed schemes without changing ordinary URLs", () => {
  assert.deepEqual(
    repairMalformedWebsiteUrl(
      "http://httphttphttps//journals.lww.com/neurosurgery/fulltext/9900/example.1535.aspx",
    ),
    {
      url: "https://journals.lww.com/neurosurgery/fulltext/9900/example.1535.aspx",
      changed: true,
      reason: "Removed duplicated or malformed HTTP/HTTPS scheme text.",
    },
  );
  assert.deepEqual(
    repairMalformedWebsiteUrl("https://example.org/paper"),
    { url: "https://example.org/paper", changed: false, reason: null },
  );
});

test("extracts an Elsevier PII and a useful Scholar fallback query", () => {
  const analysis = analyzeWebsiteRepairUrl(
    "http://httphttps//linkinghub.elsevier.com/retrieve/pii/S0960982222005632?showall=true",
  );
  assert.equal(
    analysis.url,
    "https://linkinghub.elsevier.com/retrieve/pii/S0960982222005632?showall=true",
  );
  assert.deepEqual(analysis.alternativeIds, ["S0960982222005632"]);
  assert.equal(analysis.searchQuery, "S0960982222005632");
});

test("derives conservative title words from a malformed publisher path", () => {
  assert.equal(
    titleHintFromUrl(
      "https://journals.lww.com/neurosurgery/fulltext/9900/" +
      "congress_of_neurological_surgeons_systematic.1535.aspx",
    ),
    "congress neurological surgeons systematic",
  );
});

test("constructs an encoded Google Scholar search URL", () => {
  const url = new URL(googleScholarSearchUrl("S0960982222005632"));
  assert.equal(url.origin, "https://scholar.google.com");
  assert.equal(url.pathname, "/scholar");
  assert.equal(url.searchParams.get("q"), "S0960982222005632");
});
