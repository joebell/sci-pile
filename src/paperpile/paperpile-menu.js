(function installPaperpileMenu() {
  "use strict";

  if (globalThis.__sciPilePaperpileMenuInstalled) {
    return;
  }
  globalThis.__sciPilePaperpileMenuInstalled = true;

  const core = globalThis.SciPilePaperpileMenuCore;
  if (!core) {
    return;
  }

  const REFERENCE_SELECTOR = '[data-testid="reference"]';
  const MENU_SELECTOR = '[data-testid="menu"][role="menu"]';
  const MENU_ITEM_SELECTOR = '[data-testid="menu-item"][role="menuitem"]';
  const PDF_ITEM_ATTRIBUTE = "data-scipile-paperpile-menu-item";
  const SCAN_ITEM_ATTRIBUTE = "data-scipile-paperpile-scan-item";
  const REPAIR_ITEM_ATTRIBUTE = "data-scipile-paperpile-repair-item";
  const SCAN_LABEL = "Scan with sci-pile for missing PDFs…";
  const REPAIR_LABEL = "Repair Website references with sci-pile…";
  const TARGET_MAX_AGE_MS = 15_000;
  const EXPORT_CAPTURE_TIMEOUT_MS = 60_000;
  const EXPORT_REQUEST_SOURCE = "sci-pile-paperpile-menu";
  const EXPORT_RESPONSE_SOURCE = "sci-pile-paperpile-export-bridge";
  let pendingTarget = null;
  let installScheduled = false;

  document.addEventListener("pointerdown", rememberTargetReference, true);
  document.addEventListener("click", rememberTargetReference, true);
  document.addEventListener("keydown", rememberKeyboardTarget, true);

  const observer = new MutationObserver(scheduleInstall);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scheduleInstall();

  function rememberKeyboardTarget(event) {
    if (event.key === "Enter" || event.key === " ") {
      rememberTargetReference(event);
    }
  }

  function rememberTargetReference(event) {
    const button = closestElement(event.target, "button");
    if (!button || core.normalizeLabel(button.textContent) !== "Add PDF") {
      return;
    }

    const reference = button.closest(REFERENCE_SELECTOR);
    if (!reference) {
      return;
    }

    const values = [];
    for (const link of reference.querySelectorAll("a[href]")) {
      values.push(link.getAttribute("href"), link.href, link.textContent);
    }
    for (const element of reference.querySelectorAll("[data-doi]")) {
      values.push(element.getAttribute("data-doi"));
    }

    pendingTarget = {
      capturedAt: Date.now(),
      doi: core.findDoiInValues(values),
    };
    scheduleInstall();
  }

  function closestElement(target, selector) {
    if (target instanceof Element) {
      return target.closest(selector);
    }
    return target?.parentElement?.closest(selector) ?? null;
  }

  function scheduleInstall() {
    if (installScheduled) {
      return;
    }
    installScheduled = true;
    queueMicrotask(() => {
      installScheduled = false;
      installMenuItems();
    });
  }

  function installMenuItems() {
    for (const menu of document.querySelectorAll(MENU_SELECTOR)) {
      installPdfMenuItem(menu);
      installScanMenuItem(menu);
      installRepairMenuItem(menu);
    }
  }

  function installPdfMenuItem(menu) {
    const nativeItems = [...menu.querySelectorAll(MENU_ITEM_SELECTOR)]
      .filter((item) => !item.hasAttribute(PDF_ITEM_ATTRIBUTE))
      .filter((item) => !item.hasAttribute(SCAN_ITEM_ATTRIBUTE))
      .filter((item) => !item.hasAttribute(REPAIR_ITEM_ATTRIBUTE));
    const labels = nativeItems.map(menuItemLabel);
    if (!core.isPaperpilePdfMenu(labels)) {
      return;
    }

    const findOnlineItem = nativeItems.find(
      (item) => core.normalizeLabel(menuItemLabel(item)) === "Find PDF online",
    );
    if (!findOnlineItem) {
      return;
    }

    let item = menu.querySelector(`[${PDF_ITEM_ATTRIBUTE}]`);
    if (!item) {
      item = createPdfMenuItem(findOnlineItem);
      findOnlineItem.after(item);
    }
    configurePdfMenuItem(item);
  }

  function installScanMenuItem(menu) {
    const nativeItems = [...menu.querySelectorAll(MENU_ITEM_SELECTOR)]
      .filter((item) => !item.hasAttribute(PDF_ITEM_ATTRIBUTE))
      .filter((item) => !item.hasAttribute(SCAN_ITEM_ATTRIBUTE))
      .filter((item) => !item.hasAttribute(REPAIR_ITEM_ATTRIBUTE));
    const labels = nativeItems.map(menuItemLabel);
    if (!core.isPaperpileMainMenu(labels)) {
      return;
    }

    const findOnlineItem = nativeItems.find(
      (item) => core.normalizeLabel(menuItemLabel(item)) === "Find PDFs online",
    );
    if (!findOnlineItem) {
      return;
    }

    let item = menu.querySelector(`[${SCAN_ITEM_ATTRIBUTE}]`);
    if (!item) {
      item = createScanMenuItem(findOnlineItem);
      findOnlineItem.after(item);
    }
    configureScanMenuItem(item);
  }

  function installRepairMenuItem(menu) {
    const nativeItems = [...menu.querySelectorAll(MENU_ITEM_SELECTOR)]
      .filter((item) => !item.hasAttribute(PDF_ITEM_ATTRIBUTE))
      .filter((item) => !item.hasAttribute(SCAN_ITEM_ATTRIBUTE))
      .filter((item) => !item.hasAttribute(REPAIR_ITEM_ATTRIBUTE));
    const labels = nativeItems.map(menuItemLabel);
    if (!core.isPaperpileMainMenu(labels)) {
      return;
    }

    const scanItem = menu.querySelector(`[${SCAN_ITEM_ATTRIBUTE}]`);
    const findOnlineItem = nativeItems.find(
      (item) => core.normalizeLabel(menuItemLabel(item)) === "Find PDFs online",
    );
    const template = scanItem ?? findOnlineItem;
    if (!template) {
      return;
    }

    let item = menu.querySelector(`[${REPAIR_ITEM_ATTRIBUTE}]`);
    if (!item) {
      item = createRepairMenuItem(template);
      template.after(item);
    }
    configureRepairMenuItem(item);
  }

  function menuItemLabel(item) {
    const label = [...item.children].find((child) => {
      if (child.matches?.(".pp-menu-item-hint")) {
        return false;
      }
      return child.tagName === "DIV" && core.normalizeLabel(child.textContent);
    });
    return label?.textContent ?? "";
  }

  function cloneMenuItem(template, attribute) {
    const item = template.cloneNode(true);
    item.setAttribute(attribute, "");
    item.removeAttribute("id");

    for (const hint of item.querySelectorAll(".pp-menu-item-hint")) {
      hint.remove();
    }

    const icon = item.querySelector("svg");
    if (icon) {
      icon.style.color = "#d31f26";
      icon.style.fill = "#d31f26";
      icon.setAttribute("aria-hidden", "true");
    }

    return item;
  }

  function createPdfMenuItem(template) {
    const item = cloneMenuItem(template, PDF_ITEM_ATTRIBUTE);

    item.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      void startResolution(item);
    });
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopImmediatePropagation();
        void startResolution(item);
      }
    });
    return item;
  }

  function configurePdfMenuItem(item) {
    const target = pendingTarget && Date.now() - pendingTarget.capturedAt <= TARGET_MAX_AGE_MS
      ? pendingTarget
      : null;
    const doi = target?.doi ?? null;
    const previousDoi = item.dataset.scipileDoi ?? "";
    const currentState = item.dataset.scipileState;
    if (
      previousDoi !== (doi ?? "") ||
      !["working", "started"].includes(currentState)
    ) {
      item.dataset.scipileState = "ready";
      setItemLabel(item, "Find PDF with sci-pile");
    }

    item.dataset.scipileDoi = doi ?? "";
    item.setAttribute("aria-label", "Find PDF with sci-pile");
    if (doi) {
      item.removeAttribute("aria-disabled");
      item.title = `Find and attach a PDF for ${doi}`;
    } else {
      item.setAttribute("aria-disabled", "true");
      item.title = "Sci-Pile could not identify a DOI for this reference.";
    }
  }

  function createScanMenuItem(template) {
    const item = cloneMenuItem(template, SCAN_ITEM_ATTRIBUTE);
    item.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      void startScan(item);
    });
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopImmediatePropagation();
        void startScan(item);
      }
    });
    return item;
  }

  function configureScanMenuItem(item) {
    const count = selectedCount();
    if (!["working", "started"].includes(item.dataset.scipileState)) {
      item.dataset.scipileState = "ready";
      setItemLabel(item, SCAN_LABEL);
    }
    item.setAttribute("aria-label", SCAN_LABEL);
    if (count > 0) {
      item.removeAttribute("aria-disabled");
      item.title = `Review ${count} selected Paperpile reference${count === 1 ? "" : "s"} for missing PDFs`;
    } else {
      item.setAttribute("aria-disabled", "true");
      item.title = "Select one or more Paperpile references first.";
    }
  }

  function createRepairMenuItem(template) {
    const item = cloneMenuItem(template, REPAIR_ITEM_ATTRIBUTE);
    item.removeAttribute(SCAN_ITEM_ATTRIBUTE);
    item.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      void startRepair(item);
    });
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopImmediatePropagation();
        void startRepair(item);
      }
    });
    return item;
  }

  function configureRepairMenuItem(item) {
    const count = selectedCount();
    if (!["working", "started"].includes(item.dataset.scipileState)) {
      item.dataset.scipileState = "ready";
      setItemLabel(item, REPAIR_LABEL);
    }
    item.setAttribute("aria-label", REPAIR_LABEL);
    if (count > 0) {
      item.removeAttribute("aria-disabled");
      item.title = `Review ${count} selected Paperpile reference${count === 1 ? "" : "s"} for Website repairs`;
    } else {
      item.setAttribute("aria-disabled", "true");
      item.title = "Select one or more Paperpile references first.";
    }
  }

  function selectedReferences() {
    return [...document.querySelectorAll(REFERENCE_SELECTOR)]
      .filter((reference) => reference.querySelector('input[type="checkbox"]')?.checked)
      .map((reference) => {
        const values = [];
        for (const link of reference.querySelectorAll("a[href]")) {
          values.push(link.getAttribute("href"), link.href, link.textContent);
        }
        for (const element of reference.querySelectorAll("[data-doi]")) {
          values.push(element.getAttribute("data-doi"));
        }

        const title = core.cleanReferenceText(
          reference.querySelector(".pp-grid-titletext")?.textContent ??
          reference.querySelector(".reference_title")?.textContent,
        );
        const authors = core.cleanReferenceText(
          reference.querySelector(".reference_authors")?.textContent,
        );
        const source = core.cleanReferenceText(
          reference.querySelector(".reference_sourceText")?.textContent,
        );
        const yearText = core.cleanReferenceText(
          reference.querySelector(".reference_year")?.textContent,
        );

        return {
          title,
          citation: [authors, source].filter(Boolean).join(" - "),
          year: core.referenceYear(yearText),
          doi: core.findDoiInValues(values),
          hasPdf: Boolean(reference.querySelector(".referencePdfButton")),
        };
      })
      .filter((reference) => reference.title);
  }

  function selectedCount() {
    return core.selectedReferenceCount(document.body.innerText) ?? selectedReferences().length;
  }

  async function startScan(item) {
    if (["working", "started"].includes(item.dataset.scipileState)) {
      return;
    }

    const visibleReferences = selectedReferences();
    const selectionCount = selectedCount();
    if (!selectionCount) {
      return;
    }

    item.dataset.scipileState = "working";
    item.setAttribute("aria-disabled", "true");
    setItemLabel(item, "Opening sci-pile review…");

    try {
      const references = selectionCount > visibleReferences.length
        ? await exportSelectedReferences()
        : visibleReferences;
      if (selectionCount > references.length) {
        throw new Error(
          `Paperpile reports ${selectionCount} selected references, but Sci-Pile could only read ` +
          `${references.length}. Reload this Paperpile tab and try again.`,
        );
      }
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "create-paperpile-scan",
        references,
        selectionCount,
      });
      if (!response?.ok) {
        throw new Error(response?.error ?? "Sci-Pile could not start the scan.");
      }
      item.dataset.scipileState = "started";
      item.title = "The Sci-Pile review tab is open.";
      setItemLabel(item, "sci-pile review opened");
    } catch (error) {
      item.dataset.scipileState = "error";
      item.removeAttribute("aria-disabled");
      item.title = error instanceof Error ? error.message : String(error);
      setItemLabel(item, SCAN_LABEL);
    }
  }

  async function startRepair(item) {
    if (["working", "started"].includes(item.dataset.scipileState)) {
      return;
    }

    const selectionCount = selectedCount();
    if (!selectionCount) {
      return;
    }

    item.dataset.scipileState = "working";
    item.setAttribute("aria-disabled", "true");
    setItemLabel(item, "Opening sci-pile review…");

    try {
      // Website repair always uses Paperpile's complete JSON export because
      // record ids, URLs, folders, and labels are not all present in grid rows.
      const references = await exportSelectedReferences();
      if (selectionCount > references.length) {
        throw new Error(
          `Paperpile reports ${selectionCount} selected references, but Sci-Pile could only read ` +
          `${references.length}. Reload this Paperpile tab and try again.`,
        );
      }
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "create-paperpile-repair",
        references,
        selectionCount,
      });
      if (!response?.ok) {
        throw new Error(response?.error ?? "Sci-Pile could not start the Website repair review.");
      }
      item.dataset.scipileState = "started";
      item.title = "The Sci-Pile Website repair tab is open.";
      setItemLabel(item, "sci-pile repair opened");
    } catch (error) {
      item.dataset.scipileState = "error";
      item.removeAttribute("aria-disabled");
      item.title = error instanceof Error ? error.message : String(error);
      setItemLabel(item, REPAIR_LABEL);
    }
  }

  async function exportSelectedReferences() {
    const exported = await capturePaperpileJsonExport();
    let records;
    try {
      records = JSON.parse(exported);
    } catch {
      throw new Error("Paperpile returned an unreadable selected-reference export.");
    }
    if (!Array.isArray(records)) {
      throw new Error("Paperpile did not return a selected-reference list.");
    }
    return records.map(core.referenceFromPaperpileExport).filter(Boolean);
  }

  async function capturePaperpileJsonExport() {
    const requestId = crypto.randomUUID();
    let timeoutId;
    let armed = false;
    const capture = new Promise((resolve, reject) => {
      const onMessage = (event) => {
        const message = event.data;
        if (
          event.source !== window ||
          event.origin !== location.origin ||
          message?.source !== EXPORT_RESPONSE_SOURCE ||
          message.requestId !== requestId
        ) {
          return;
        }
        if (message.type === "paperpile-copy-capture-armed") {
          armed = true;
          clearTimeout(timeoutId);
          timeoutId = setTimeout(onTimeout, EXPORT_CAPTURE_TIMEOUT_MS);
          dispatchPaperpileJsonShortcut();
          return;
        }
        if (message.type !== "paperpile-copy-captured") {
          return;
        }
        cleanup();
        resolve(message.text);
      };
      const cleanup = () => {
        clearTimeout(timeoutId);
        window.removeEventListener("message", onMessage);
      };
      const onTimeout = () => {
        cleanup();
        window.postMessage({
          source: EXPORT_REQUEST_SOURCE,
          type: "cancel-paperpile-copy-capture",
          requestId,
        }, location.origin);
        reject(new Error(
          armed
            ? "Paperpile did not finish exporting the complete selection in time."
            : "Paperpile's full selected-reference export was unavailable. Reload this Paperpile tab and try again.",
        ));
      };

      timeoutId = setTimeout(onTimeout, 2_500);
      window.addEventListener("message", onMessage);
    });

    window.postMessage({
      source: EXPORT_REQUEST_SOURCE,
      type: "capture-next-paperpile-copy",
      requestId,
    }, location.origin);
    return await capture;
  }

  function dispatchPaperpileJsonShortcut() {
    const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
    const target = document.activeElement instanceof Element
      ? document.activeElement
      : document.body;
    const options = {
      key: "j",
      code: "KeyJ",
      keyCode: 74,
      which: 74,
      bubbles: true,
      cancelable: true,
      composed: true,
      metaKey: isMac,
      ctrlKey: !isMac,
    };
    target.dispatchEvent(new KeyboardEvent("keydown", options));
    target.dispatchEvent(new KeyboardEvent("keyup", options));
  }

  async function startResolution(item) {
    const doi = item.dataset.scipileDoi;
    if (!doi || ["working", "started"].includes(item.dataset.scipileState)) {
      return;
    }

    item.dataset.scipileState = "working";
    item.setAttribute("aria-disabled", "true");
    setItemLabel(item, "Starting sci-pile…");

    try {
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "resolve-paperpile-reference",
        doi,
      });
      if (!response?.ok) {
        throw new Error(response?.error ?? "Sci-Pile could not start this reference.");
      }
      item.dataset.scipileState = "started";
      item.title = `Sci-Pile is resolving ${response.result.doi}`;
      setItemLabel(item, "sci-pile started");
    } catch (error) {
      item.dataset.scipileState = "error";
      item.removeAttribute("aria-disabled");
      item.title = error instanceof Error ? error.message : String(error);
      setItemLabel(item, "Find PDF with sci-pile");
    }
  }

  function setItemLabel(item, value) {
    const label = [...item.children].find((child) => child.tagName === "DIV");
    if (label && label.textContent !== value) {
      label.textContent = value;
    }
  }
})();
