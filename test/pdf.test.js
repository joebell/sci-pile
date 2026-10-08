import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { probeDocument } from "../src/lib/pdf.js";

async function withServer(run) {
  const server = http.createServer((request, response) => {
    switch (request.url) {
      case "/pdf":
        response.writeHead(200, { "content-type": "application/pdf" });
        response.end("%PDF-1.7\nmock pdf body");
        break;
      case "/html":
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><title>Not a PDF</title>");
        break;
      case "/challenge":
        response.writeHead(403, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>Verify you are human</title><div class='captcha'>Challenge</div>");
        break;
      case "/redirect":
        response.writeHead(302, { location: "/pdf" });
        response.end();
        break;
      default:
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("missing");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("accepts a response containing a PDF signature", async () => {
  await withServer(async (baseUrl) => {
    const result = await probeDocument(`${baseUrl}/pdf`);
    assert.equal(result.finalUrl, `${baseUrl}/pdf`);
    assert.equal(result.kind, "pdf");
    assert.equal(result.diagnostic.response.status, 200);
    assert.equal(result.diagnostic.response.contentType, "application/pdf");
    assert.equal(result.diagnostic.inspection.pdfSignatureFound, true);
    assert.match(result.diagnostic.inspection.firstBytesText, /%PDF-1\.7/);
  });
});

test("follows a redirect to a PDF", async () => {
  await withServer(async (baseUrl) => {
    const result = await probeDocument(`${baseUrl}/redirect`);
    assert.equal(result.finalUrl, `${baseUrl}/pdf`);
    assert.equal(result.diagnostic.response.redirected, true);
    assert.equal(result.diagnostic.response.finalUrl, `${baseUrl}/pdf`);
  });
});

test("returns HTML landing pages and rejects HTTP errors", async () => {
  await withServer(async (baseUrl) => {
    const htmlResult = await probeDocument(`${baseUrl}/html`);
    assert.equal(htmlResult.kind, "html");
    assert.equal(htmlResult.finalUrl, `${baseUrl}/html`);
    assert.equal(htmlResult.diagnostic.response.status, 200);
    assert.equal(htmlResult.diagnostic.response.contentType, "text/html");
    assert.equal(htmlResult.diagnostic.inspection.htmlDetected, true);
    assert.equal(htmlResult.diagnostic.inspection.htmlTruncated, false);
    assert.match(htmlResult.html, /Not a PDF/);
    assert.match(htmlResult.diagnostic.inspection.firstBytesText, /doctype html/i);

    await assert.rejects(
      () => probeDocument(`${baseUrl}/missing`),
      (error) => {
        assert.match(error.message, /HTTP 404/);
        assert.equal(error.diagnostic.response.status, 404);
        return true;
      },
    );
  });
});

test("returns interactive HTML error pages for challenge detection", async () => {
  await withServer(async (baseUrl) => {
    const result = await probeDocument(`${baseUrl}/challenge`);
    assert.equal(result.kind, "html");
    assert.equal(result.diagnostic.response.status, 403);
    assert.match(result.html, /captcha/);
  });
});

test("passes the selected credential policy to fetch", async () => {
  let fetchOptions;
  const result = await probeDocument("https://example.test/paper.pdf", {
    credentials: "include",
    fetchImpl: async (_url, options) => {
      fetchOptions = options;
      return new Response("%PDF-1.7\nmock", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    },
  });

  assert.equal(result.kind, "pdf");
  assert.equal(fetchOptions.credentials, "include");
});
