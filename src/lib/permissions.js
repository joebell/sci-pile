export const ALL_HTTP_ORIGINS = Object.freeze([
  "https://*/*",
  "http://*/*",
]);

export async function hasAllHttpHostAccess() {
  return chrome.permissions.contains({ origins: ALL_HTTP_ORIGINS });
}

export async function hasHttpHostAccess(origin) {
  if (await hasAllHttpHostAccess()) {
    return true;
  }
  return chrome.permissions.contains({ origins: [origin] });
}
