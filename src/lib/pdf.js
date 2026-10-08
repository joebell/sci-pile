import { hasHtmlSignature, hasPdfSignature } from "./core.js";

export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
export const DEFAULT_HEADER_SCAN_BYTES = 1024;
export const DEFAULT_HTML_SCAN_BYTES = 1_000_000;

const INTERACTIVE_HTTP_STATUSES = new Set([401, 403, 429]);

export class PdfProbeError extends Error {
  constructor(message, diagnostic) {
    super(message);
    this.name = "PdfProbeError";
    this.diagnostic = diagnostic;
  }
}

export async function probeDocument(
  url,
  {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    headerScanBytes = DEFAULT_HEADER_SCAN_BYTES,
    htmlScanBytes = DEFAULT_HTML_SCAN_BYTES,
    credentials = "omit",
  } = {},
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const diagnostic = {
    requestedUrl: url,
    startedAt: new Date(startedAt).toISOString(),
  };

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      credentials,
      headers: {
        Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1",
      },
      signal: controller.signal,
    });

    diagnostic.response = {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      type: response.type,
      redirected: response.redirected,
      finalUrl: response.url || url,
      contentType: response.headers.get("content-type"),
      contentLength: response.headers.get("content-length"),
      contentDisposition: response.headers.get("content-disposition"),
      contentEncoding: response.headers.get("content-encoding"),
    };

    if (!response.ok && !INTERACTIVE_HTTP_STATUSES.has(response.status)) {
      throw new PdfProbeError(
        `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
        diagnostic,
      );
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const sample = await readResponseSample(response, {
      headerScanBytes,
      htmlScanBytes,
      contentType,
    });
    const prefix = sample.bytes.slice(0, headerScanBytes);
    diagnostic.inspection = {
      bytesRead: prefix.length,
      pdfSignatureFound: hasPdfSignature(prefix),
      htmlDetected: contentType.includes("text/html") || hasHtmlSignature(prefix),
      firstBytesHex: bytesToHex(prefix, 32),
      firstBytesText: bytesToPrintableText(prefix, 80),
    };

    if (diagnostic.inspection.pdfSignatureFound && response.ok) {
      diagnostic.completedAt = new Date().toISOString();
      diagnostic.durationMs = Date.now() - startedAt;
      return { kind: "pdf", finalUrl: response.url || url, diagnostic };
    }

    if (diagnostic.inspection.htmlDetected) {
      diagnostic.inspection.htmlBytesRead = sample.bytes.length;
      diagnostic.inspection.htmlTruncated = sample.truncated;
      diagnostic.completedAt = new Date().toISOString();
      diagnostic.durationMs = Date.now() - startedAt;
      return {
        kind: "html",
        finalUrl: response.url || url,
        html: decodeHtml(sample.bytes, contentType),
        diagnostic,
      };
    }

    if (!response.ok) {
      throw new PdfProbeError(
        `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
        diagnostic,
      );
    }

    const reportedContentType = response.headers.get("content-type") ?? "unknown content type";
    throw new PdfProbeError(
      `Response was neither a PDF nor an HTML landing page (${reportedContentType})`,
      diagnostic,
    );
  } catch (error) {
    diagnostic.completedAt = new Date().toISOString();
    diagnostic.durationMs = Date.now() - startedAt;

    if (error?.name === "AbortError") {
      diagnostic.error = {
        name: error.name,
        message: `Timed out after ${timeoutMs / 1000} seconds`,
      };
      throw new PdfProbeError(diagnostic.error.message, diagnostic);
    }

    if (error instanceof PdfProbeError) {
      diagnostic.error = {
        name: error.name,
        message: error.message,
      };
      throw error;
    }

    diagnostic.error = {
      name: error?.name ?? "Error",
      message: error instanceof Error ? error.message : String(error),
    };
    throw new PdfProbeError(diagnostic.error.message, diagnostic);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function readResponsePrefix(response, byteLimit) {
  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;

  try {
    while (length < byteLimit) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      const remaining = byteLimit - length;
      const chunk = value.length > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      length += chunk.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

export async function readResponseSample(
  response,
  { headerScanBytes, htmlScanBytes, contentType = "" },
) {
  if (!response.body) {
    return { bytes: new Uint8Array(), truncated: false };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let done = false;
  let htmlDetected = contentType.includes("text/html");

  try {
    while (length < htmlScanBytes) {
      const next = await reader.read();
      done = next.done;
      if (done) {
        break;
      }

      const remaining = htmlScanBytes - length;
      const chunk = next.value.length > remaining
        ? next.value.slice(0, remaining)
        : next.value;
      chunks.push(chunk);
      length += chunk.length;

      if (length >= headerScanBytes && !htmlDetected) {
        htmlDetected = hasHtmlSignature(
          combineChunks(chunks, length).slice(0, headerScanBytes),
        );
        if (!htmlDetected) {
          break;
        }
      }
    }
  } finally {
    if (!done) {
      await reader.cancel().catch(() => {});
    }
  }

  return {
    bytes: combineChunks(chunks, length),
    truncated: htmlDetected && !done && length >= htmlScanBytes,
  };
}

function combineChunks(chunks, length) {
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

function decodeHtml(bytes, contentType) {
  const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function bytesToHex(bytes, limit) {
  return [...bytes.slice(0, limit)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

function bytesToPrintableText(bytes, limit) {
  return [...bytes.slice(0, limit)]
    .map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "."))
    .join("");
}
