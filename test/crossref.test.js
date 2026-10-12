import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveDoiFromAlternativeId,
  resolveDoiFromBibliographicMetadata,
  titleSimilarity,
} from "../src/lib/crossref.js";

test("scores punctuation and subtitle variations as the same scholarly title", () => {
  assert.ok(titleSimilarity(
    "A practical test: methods and results",
    "A practical test—methods and results",
  ) > 0.95);
});

test("resolves an exact Crossref publisher alternative id", async () => {
  let requestedUrl = null;
  const result = await resolveDoiFromAlternativeId("S0960982222005632", {
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return new Response(JSON.stringify({
        message: {
          items: [{
            DOI: "10.1016/j.cub.2022.03.076",
            title: ["Running in the wild: Energetics explain ecological running speeds"],
            "alternative-id": ["S0960982222005632"],
            issued: { "date-parts": [[2022]] },
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(requestedUrl.searchParams.get("filter"), "alternative-id:S0960982222005632");
  assert.equal(result.doi, "10.1016/j.cub.2022.03.076");
  assert.equal(result.match.source, "Crossref alternative-id");
});

test("rejects a Crossref alternative-id response without an exact unique id", async () => {
  await assert.rejects(
    () => resolveDoiFromAlternativeId("S0960982222005632", {
      fetchImpl: async () => new Response(JSON.stringify({
        message: {
          items: [{
            DOI: "10.1000/wrong",
            title: ["Wrong paper"],
            "alternative-id": ["S0000000000000000"],
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    }),
    /No unique DOI matched/,
  );
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
