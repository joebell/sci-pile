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
  const ITEM_ATTRIBUTE = "data-scipile-paperpile-menu-item";
  const TARGET_MAX_AGE_MS = 15_000;
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
      installMenuItem(menu);
    }
  }

  function installMenuItem(menu) {
    const nativeItems = [...menu.querySelectorAll(MENU_ITEM_SELECTOR)]
      .filter((item) => !item.hasAttribute(ITEM_ATTRIBUTE));
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

    let item = menu.querySelector(`[${ITEM_ATTRIBUTE}]`);
    if (!item) {
      item = createMenuItem(findOnlineItem);
      findOnlineItem.after(item);
    }
    configureMenuItem(item);
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

  function createMenuItem(template) {
    const item = template.cloneNode(true);
    item.setAttribute(ITEM_ATTRIBUTE, "");
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

  function configureMenuItem(item) {
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
