import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_HTTP_ORIGINS,
  hasAllHttpHostAccess,
  hasHttpHostAccess,
} from "../src/lib/permissions.js";

test("all-site access covers both HTTPS and HTTP", () => {
  assert.deepEqual([...ALL_HTTP_ORIGINS], ["https://*/*", "http://*/*"]);
});

test("host access accepts the one-time all-sites permission", async () => {
  const calls = [];
  globalThis.chrome = {
    permissions: {
      contains: async (request) => {
        calls.push(request);
        return request.origins.length === 2;
      },
    },
  };

  assert.equal(await hasAllHttpHostAccess(), true);
  assert.equal(await hasHttpHostAccess("https://example.org/*"), true);
  assert.deepEqual(calls, [
    { origins: ALL_HTTP_ORIGINS },
    { origins: ALL_HTTP_ORIGINS },
  ]);
});

test("host access falls back to a narrowly granted origin", async () => {
  const requested = [];
  globalThis.chrome = {
    permissions: {
      contains: async ({ origins }) => {
        requested.push(origins);
        return origins.length === 1 && origins[0] === "https://example.org/*";
      },
    },
  };

  assert.equal(await hasHttpHostAccess("https://example.org/*"), true);
  assert.deepEqual(requested, [
    ALL_HTTP_ORIGINS,
    ["https://example.org/*"],
  ]);
});
