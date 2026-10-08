const RESULT_SELECTOR = ".gs_r";
const PAPERPILE_WRAPPER_SELECTOR = ".react-webimport-wrapper";
const WRAPPER_CLASS = "scipile-scholar-wrapper";
const BUTTON_CLASS = "scipile-scholar-button";
const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;

installButtons();

const observer = new MutationObserver(() => installButtons());
observer.observe(document.documentElement, { childList: true, subtree: true });

function installButtons() {
  for (const result of document.querySelectorAll(RESULT_SELECTOR)) {
    const paperpileWrapper = result.querySelector(PAPERPILE_WRAPPER_SELECTOR);
    if (!paperpileWrapper) {
      // Paperpile injects its control asynchronously. The document observer
      // calls this function again when that wrapper appears.
      continue;
    }

    let wrapper = result.querySelector(`.${WRAPPER_CLASS}`);
    if (wrapper) {
      if (wrapper.previousElementSibling !== paperpileWrapper) {
        paperpileWrapper.after(wrapper);
      }
      continue;
    }

    wrapper = document.createElement("div");
    wrapper.className = WRAPPER_CLASS;

    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.title = "Find, download, and attach this result with sci-pile";

    const addIcon = document.createElement("span");
    addIcon.className = "scipile-scholar-add-icon";
    addIcon.setAttribute("aria-hidden", "true");
    addIcon.textContent = "+";

    const label = document.createElement("span");
    label.className = "scipile-scholar-label";
    label.textContent = "sci-pile";

    button.append(addIcon, label);
    button.addEventListener("click", () => void handleClick(button, result));
    wrapper.append(button);
    paperpileWrapper.after(wrapper);
  }
}

async function handleClick(button, result) {
  if (button.disabled) {
    return;
  }

  button.disabled = true;
  button.dataset.state = "working";
  setButtonLabel(button, "sci-pile…");

  try {
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "resolve-scholar-result",
      result: extractResult(result),
    });
    if (!response?.ok) {
      throw new Error(response?.error ?? "Sci-Pile could not start this result.");
    }

    button.dataset.state = "started";
    setButtonLabel(button, "sci-pile");
    button.title = `Resolving DOI ${response.result.doi}`;
  } catch (error) {
    button.dataset.state = "error";
    setButtonLabel(button, "sci-pile");
    button.title = error instanceof Error ? error.message : String(error);
    button.disabled = false;
  }
}

function setButtonLabel(button, value) {
  const label = button.querySelector(".scipile-scholar-label");
  if (label) {
    label.textContent = value;
  }
}

function extractResult(result) {
  const titleElement = result.querySelector(".gs_rt");
  const titleLink = titleElement?.querySelector("a[href]");
  const citation = result.querySelector(".gs_a")?.textContent?.trim() ?? "";
  const yearMatch = citation.match(/\b(?:19|20)\d{2}\b/);
  const doi = findDoi(result);

  return {
    doi,
    title: (titleLink?.textContent ?? titleElement?.textContent ?? "")
      .replace(/^\s*\[[^\]]+\]\s*/, "")
      .trim(),
    citation,
    year: yearMatch ? Number(yearMatch[0]) : null,
    resultUrl: titleLink?.href ?? null,
  };
}

function findDoi(result) {
  const values = [result.textContent ?? ""];
  for (const link of result.querySelectorAll("a[href]")) {
    values.push(link.href);
    try {
      const url = new URL(link.href);
      values.push(decodeURIComponent(url.href));
      values.push(url.searchParams.get("q") ?? "");
      values.push(url.searchParams.get("url") ?? "");
    } catch {
      // Ignore malformed result links.
    }
  }

  for (const value of values) {
    const match = value.match(DOI_PATTERN);
    if (match) {
      return cleanDoi(match[0]);
    }
  }
  return null;
}

function cleanDoi(value) {
  let doi = value.replace(/[.,;:!?]+$/, "");
  while (doi.endsWith(")") &&
    [...doi].filter((character) => character === ")").length >
    [...doi].filter((character) => character === "(").length) {
    doi = doi.slice(0, -1).replace(/[.,;:!?]+$/, "");
  }
  return doi;
}
