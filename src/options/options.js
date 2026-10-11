import {
  originPattern,
  validatePrefix,
} from "../lib/core.js";

const PREFIXES_KEY = "prefixes";
const AUTOMATIC_REDIRECT_ORIGINS = ["https://*/*", "http://*/*"];
const list = document.querySelector("#prefix-list");
const emptyState = document.querySelector("#empty-state");
const template = document.querySelector("#prefix-row-template");
const addButton = document.querySelector("#add-prefix");
const saveButton = document.querySelector("#save");
const status = document.querySelector("#status");
const automaticRedirects = document.querySelector("#automatic-redirects");
const redirectStatus = document.querySelector("#redirect-status");

initialize();

async function initialize() {
  const { prefixes = [] } = await chrome.storage.sync.get(PREFIXES_KEY);
  for (const prefix of prefixes) {
    addRow(prefix);
  }
  updateRows();

  automaticRedirects.checked = await chrome.permissions.contains({
    origins: AUTOMATIC_REDIRECT_ORIGINS,
  });
}

automaticRedirects.addEventListener("change", () => {
  automaticRedirects.disabled = true;
  redirectStatus.textContent = automaticRedirects.checked
    ? "Waiting for Chrome's permission prompt…"
    : "Removing all-sites access…";

  if (automaticRedirects.checked) {
    // Keep this request directly inside the change handler. Chrome requires a
    // user gesture before it will show the optional all-sites access prompt.
    chrome.permissions.request(
      { origins: AUTOMATIC_REDIRECT_ORIGINS },
      (granted) => {
        automaticRedirects.disabled = false;
        if (chrome.runtime.lastError) {
          automaticRedirects.checked = false;
          redirectStatus.textContent = chrome.runtime.lastError.message;
          return;
        }

        automaticRedirects.checked = granted;
        redirectStatus.textContent = granted
          ? "Automatic redirects enabled. Future redirect hosts will not need individual approval."
          : "All-sites access was not granted. Redirect hosts will continue to require individual approval.";
      },
    );
    return;
  }

  chrome.permissions.remove(
    { origins: AUTOMATIC_REDIRECT_ORIGINS },
    (removed) => {
      automaticRedirects.disabled = false;
      if (chrome.runtime.lastError) {
        automaticRedirects.checked = true;
        redirectStatus.textContent = chrome.runtime.lastError.message;
        return;
      }

      automaticRedirects.checked = !removed;
      if (removed) {
        void reportAutomaticRedirectsDisabled();
      } else {
        redirectStatus.textContent = "Chrome did not remove all-sites access.";
      }
    },
  );
});

async function reportAutomaticRedirectsDisabled() {
  const { prefixes = [] } = await chrome.storage.sync.get(PREFIXES_KEY);
  const configuredOrigins = [...new Set(prefixes.map(originPattern))];
  const checks = await Promise.all(configuredOrigins.map((origin) =>
    chrome.permissions.contains({ origins: [origin] })
  ));
  const missingConfiguredAccess = checks.some((granted) => !granted);

  redirectStatus.textContent = missingConfiguredAccess
    ? "Automatic redirects disabled. Click Save sources once to restore configured-site access."
    : "Automatic redirects disabled. New redirect hosts will require individual approval.";
}

addButton.addEventListener("click", () => {
  const row = addRow("");
  row.querySelector("input").focus();
});

saveButton.addEventListener("click", () => {
  status.textContent = "";
  const result = collectPrefixes();
  if (!result.valid) {
    status.textContent = "Fix the highlighted source before saving.";
    return;
  }

  const requestedOrigins = [...new Set(result.prefixes.map(originPattern))];
  if (!requestedOrigins.length) {
    void finishSave(result.prefixes, requestedOrigins);
    return;
  }

  // Keep this call directly inside the click handler: Chrome requires a user
  // gesture before it will show an optional host-permission prompt.
  chrome.permissions.request({ origins: requestedOrigins }, (granted) => {
    if (chrome.runtime.lastError) {
      status.textContent = chrome.runtime.lastError.message;
      return;
    }

    if (!granted) {
      status.textContent = "Site access was not granted, so the sources were not saved.";
      return;
    }

    void finishSave(result.prefixes, requestedOrigins);
  });
});

function addRow(value) {
  const fragment = template.content.cloneNode(true);
  const row = fragment.querySelector("li");
  const input = row.querySelector("input");
  input.value = value;

  row.querySelector(".move-up").addEventListener("click", () => {
    const previous = row.previousElementSibling;
    if (previous) {
      list.insertBefore(row, previous);
      updateRows();
    }
  });

  row.querySelector(".move-down").addEventListener("click", () => {
    const next = row.nextElementSibling;
    if (next) {
      list.insertBefore(next, row);
      updateRows();
    }
  });

  row.querySelector(".remove").addEventListener("click", () => {
    row.remove();
    updateRows();
  });

  input.addEventListener("input", () => {
    row.classList.remove("invalid");
    row.querySelector(".row-error").textContent = "";
    status.textContent = "";
  });

  list.append(fragment);
  updateRows();
  return row;
}

function updateRows() {
  const rows = [...list.querySelectorAll(".prefix-row")];
  emptyState.hidden = rows.length > 0;

  rows.forEach((row, index) => {
    row.querySelector(".order").textContent = String(index + 1);
    row.querySelector(".move-up").disabled = index === 0;
    row.querySelector(".move-down").disabled = index === rows.length - 1;
  });
}

function collectPrefixes() {
  const prefixes = [];
  let valid = true;

  for (const row of list.querySelectorAll(".prefix-row")) {
    const input = row.querySelector("input");
    const errorElement = row.querySelector(".row-error");
    row.classList.remove("invalid");
    errorElement.textContent = "";

    try {
      const prefix = validatePrefix(input.value);
      if (prefixes.includes(prefix)) {
        throw new Error("This prefix is already in the list.");
      }
      prefixes.push(prefix);
    } catch (error) {
      valid = false;
      row.classList.add("invalid");
      errorElement.textContent = error.message;
    }
  }

  return { valid, prefixes };
}

async function finishSave(prefixes, requestedOrigins) {
  const { prefixes: oldPrefixes = [] } = await chrome.storage.sync.get(PREFIXES_KEY);
  const oldOrigins = new Set(oldPrefixes.map(originPattern));
  const newOrigins = new Set(requestedOrigins);
  const unusedOrigins = [...oldOrigins].filter((origin) => !newOrigins.has(origin));

  await chrome.storage.sync.set({ [PREFIXES_KEY]: prefixes });

  if (unusedOrigins.length) {
    await chrome.permissions.remove({ origins: unusedOrigins }).catch(() => false);
  }

  status.textContent = prefixes.length
    ? `Saved ${prefixes.length} source${prefixes.length === 1 ? "" : "s"}.`
    : "Saved an empty source list.";
}
