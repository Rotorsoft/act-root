/**
 * Service Worker that monitors npm registry requests and notifies the UI.
 * Intercepts ALL fetch requests (including from iframes and workers).
 *
 * Two URL patterns are matched:
 * 1. registry.npmjs.org — original URLs (rewritten to /npm-registry/ proxy)
 * 2. /npm-registry/ — already-rewritten URLs from the Worker bootstrap or
 *    main thread fetch patch (passed through, notification only)
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim())
);

function notifyClients(data) {
  self.clients.matchAll().then((clients) => {
    for (const client of clients) {
      if (client.type === "window") client.postMessage(data);
    }
  });
}

/**
 * Extract package name and tarball flag from an npm registry path.
 * Handles: @scope/name, @scope/name/latest, name, name/latest, name/-/name-1.0.tgz
 */
function parseNpmPath(npmPath) {
  const isTarball = npmPath.includes(".tgz");
  if (isTarball) {
    var pkgName = npmPath.split("/-/")[0];
    // Extract version from tarball filename: name-1.2.3.tgz → 1.2.3
    var tgzPart = npmPath.split("/-/")[1] || "";
    var verMatch = tgzPart.match(/-(\d+\.\d+[^.]*?)\.tgz$/);
    return { pkgName, isTarball, version: verMatch ? verMatch[1] : undefined };
  }

  // Strip version/tag suffix: @scope/name/latest → @scope/name, name/1.2.3 → name
  var parts = npmPath.replace(/\/$/, "").split("/");
  var pkgName = parts[0].startsWith("@")
    ? parts[0] + "/" + (parts[1] || "")
    : parts[0];
  return { pkgName, isTarball, version: undefined };
}

self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // Case 1: original registry.npmjs.org URL — rewrite and proxy
  if (url.includes("registry.npmjs.org")) {
    const npmPath = url.replace(/https?:\/\/registry\.npmjs\.org\//, "");
    const { pkgName, isTarball, version } = parseNpmPath(npmPath);

    notifyClients({ type: "npm-fetch-start", pkg: pkgName, isTarball });

    const rewritten = url.replace(
      /https?:\/\/registry\.npmjs\.org\//,
      self.location.origin + "/npm-registry/"
    );
    event.respondWith(
      fetch(
        new Request(rewritten, {
          method: event.request.method,
          headers: event.request.headers,
          body: event.request.method !== "GET" ? event.request.body : undefined,
        })
      ).then((response) => {
        notifyClients({
          type: "npm-fetch-done",
          pkg: pkgName,
          isTarball,
          version,
          status: response.status,
        });
        return response;
      })
    );
    return;
  }

  // Case 2: already-rewritten /npm-registry/ URL — notify only, don't rewrite
  const proxyMatch = url.match(/\/npm-registry\/(.+)/);
  if (proxyMatch) {
    const npmPath = proxyMatch[1];
    const { pkgName, isTarball, version } = parseNpmPath(npmPath);

    notifyClients({ type: "npm-fetch-start", pkg: pkgName, isTarball });

    event.respondWith(
      fetch(event.request).then((response) => {
        notifyClients({
          type: "npm-fetch-done",
          pkg: pkgName,
          isTarball,
          version,
          status: response.status,
        });
        return response;
      })
    );
    return;
  }
});
