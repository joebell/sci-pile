import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveDoiFromBibliographicMetadata,
  titleSimilarity,
} from "../src/lib/crossref.js";

test("scores punctuation and subtitle variations as the same scholarly title", () => {
  assert.ok(titleSimilarity(
    "A practical test: methods and results",
    "A practical test—methods and results",
  ) > 0.95);
});

test("resolves a conservative Crossref match by title, author, and year", async () => {
  const result = await resolveDoiFromBibliographicMetadata({
    title: "Seizure outcome during thalamic stimulation",
    citation: "J Cukiert, A Example - Seizure, 2020 - Publisher",
    year: 2020,
  }, {
    fetchImpl: async () => new Response(JSON.stringify({
      message: {
        items: [{
          DOI: "10.1016/j.seizure.2020.08.028",
          title: ["Seizure outcome during thalamic stimulation"],
          author: [{ family: "Cukiert" }],
          issued: { "date-parts": [[2020]] },
          score: 100,
        }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.equal(result.doi, "10.1016/j.seizure.2020.08.028");
  assert.equal(result.match.yearMatched, true);
  assert.equal(result.match.authorMatched, true);
});

test("rejects an ambiguous Crossref title match", async () => {
  await assert.rejects(
    () => resolveDoiFromBibliographicMetadata({
      title: "A completely different article title",
      citation: "A Author - Journal, 2020",
      year: 2020,
    }, {
      fetchImpl: async () => new Response(JSON.stringify({
        message: {
          items: [{
            DOI: "10.1000/wrong",
            title: ["Unrelated research"],
            author: [{ family: "Someone" }],
            issued: { "date-parts": [[2011]] },
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    }),
    /No unambiguous DOI match/,
  );
});
