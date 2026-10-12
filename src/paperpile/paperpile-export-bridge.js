(function installSciPilePaperpileExportBridge() {
  "use strict";

  if (globalThis.__sciPilePaperpileExportBridgeInstalled) {
    return;
  }
  globalThis.__sciPilePaperpileExportBridgeInstalled = true;

  const clipboard = navigator.clipboard;
  const originalWriteText = clipboard?.writeText?.bind(clipboard);
  if (!clipboard || !originalWriteText) {
    return;
  }

  const REQUEST_SOURCE = "sci-pile-paperpile-menu";
  const RESPONSE_SOURCE = "sci-pile-paperpile-export-bridge";
  const CAPTURE_TIMEOUT_MS = 60_000;
  let pendingCapture = null;

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) {
      return;
    }
    const message = event.data;
    if (message?.source !== REQUEST_SOURCE || typeof message.requestId !== "string") {
      return;
    }

    if (message.type === "capture-next-paperpile-copy") {
      pendingCapture = {
        requestId: message.requestId,
        expiresAt: Date.now() + CAPTURE_TIMEOUT_MS,
      };
      respond("paperpile-copy-capture-armed", message.requestId);
    } else if (
      message.type === "cancel-paperpile-copy-capture" &&
      pendingCapture?.requestId === message.requestId
    ) {
      pendingCapture = null;
    }
  });

  // Paperpile binds this method while its application bundle starts. Installing
  // this bridge at document_start lets Sci-Pile capture one explicitly requested
  // export while every ordinary Paperpile copy still goes to the clipboard.
  clipboard.writeText = async (value) => {
    const capture = pendingCapture;
    if (capture && capture.expiresAt >= Date.now()) {
      pendingCapture = null;
      respond("paperpile-copy-captured", capture.requestId, {
        text: typeof value === "string" ? value : String(value ?? ""),
      });
      return;
    }

    if (capture) {
      pendingCapture = null;
    }
    return await originalWriteText(value);
  };

  function respond(type, requestId, extra = {}) {
    window.postMessage({
      source: RESPONSE_SOURCE,
      type,
      requestId,
      ...extra,
    }, location.origin);
  }
})();
