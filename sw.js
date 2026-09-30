/*
 * Service Worker for the offline PWA build of the داشبورد بازاریابی و فروش.
 *
 * The whole Flask app runs INSIDE this service worker via Pyodide (Python
 * compiled to WebAssembly). Every request for a page or an /api/* endpoint
 * is answered by real Python code (the exact same app/ package used by the
 * normal server) - nothing about routes, templates or analytics logic is
 * reimplemented for the offline build.
 *
 * Static/vendor assets (Pyodide runtime, the app's own Python source as
 * plain text files, JS/CSS, icons) are cached on install so the app keeps
 * working with zero network access after the first successful load.
 *
 * Data persistence: the SQLite database file lives in Pyodide's in-memory
 * filesystem during a session, mounted under /persist via IDBFS and synced
 * to the browser's IndexedDB (so it survives closing the app) after every
 * request that could have changed data.
 */

const CACHE_VERSION = "nasr-pwa-v1";
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const CORE_ASSETS = [
  "/", "/static/pwa/manifest.json",
  "/static/pwa/icons/icon-192.png", "/static/pwa/icons/icon-512.png", "/static/pwa/icons/icon-512-maskable.png",
  "/static/css/style.css",
  "/static/js/main.js", "/static/js/dashboard.js", "/static/js/experts.js",
  "/static/js/region_map.js", "/static/js/region_detail.js", "/static/js/reports.js",
  "/static/js/admin.js", "/static/js/ai_analysis.js",
  "/static/vendor/chart.umd.min.js",
  "/static/vendor/pyodide/pyodide.js", "/static/vendor/pyodide/pyodide.mjs",
  "/static/vendor/pyodide/pyodide.asm.js", "/static/vendor/pyodide/pyodide.asm.wasm",
  "/static/vendor/pyodide/python_stdlib.zip", "/static/vendor/pyodide/pyodide-lock.json",
  "/static/vendor/pyodide/sqlalchemy-2.0.29-cp312-cp312-pyodide_2024_0_wasm32.whl",
  "/static/vendor/pyodide/sqlite3-1.0.0-cp312-cp312-pyodide_2024_0_wasm32.whl",
  "/static/vendor/pyodide/markupsafe-2.1.5-cp312-cp312-pyodide_2024_0_wasm32.whl",
  "/static/pwa/pwa_backend.py", "/static/pwa/app-files.json",
];

// Paths whose fetches are served from the cache (network-refreshed in the
// background) instead of being routed into the Python/WSGI layer. The one
// exception is an admin-uploaded logo: it can change after install and is
// persisted by Python itself (see pwa_backend.boot's static_folder), so it
// must be routed there instead of the immutable-assets cache.
function isStaticAssetPath(path) {
  if (path.startsWith("/static/assets/")) return false;
  return (
    path.startsWith("/static/") ||
    path === "/manifest.json" ||
    path === "/sw.js"
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.addAll(CORE_ASSETS);
      const wheelList = await (await fetch("/static/pwa/wheels-manifest.json")).json();
      await cache.addAll(wheelList);
      const appFiles = await (await fetch("/static/pwa/app-files.json")).json();
      await cache.addAll(appFiles);
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== RUNTIME_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
      await bootPyodideOnce();
    })()
  );
});

// ---------------------------------------------------------------------
// Pyodide boot (once per service-worker lifetime)
// ---------------------------------------------------------------------
let pyodideReadyPromise = null;

async function bootPyodideOnce() {
  if (pyodideReadyPromise) return pyodideReadyPromise;
  pyodideReadyPromise = (async () => {
    importScripts("/static/vendor/pyodide/pyodide.js");
    const pyodide = await loadPyodide({ indexURL: "/static/vendor/pyodide/" });

    await pyodide.loadPackage(["sqlite3", "sqlalchemy", "markupsafe"]);

    const wheelManifest = await (await fetch("/static/pwa/wheels-manifest.json")).json();
    const micropip = pyodide.pyimport("micropip");
    const wheelUrls = wheelManifest.map((u) => new URL(u, self.location.origin).href);
    // deps=False: every transitive pure-Python dependency this app needs is
    // already in the bundle (verified by hand against each package's own
    // metadata) - this avoids any PyPI network round-trip after the very
    // first install, and keeps install order irrelevant.
    await micropip.install(wheelUrls, { deps: false });

    // Mount the persistent data directory (IndexedDB-backed) and pull in
    // whatever was saved from a previous session, before the app boots and
    // opens its SQLite file there.
    pyodide.FS.mkdirTree("/persist");
    pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, {}, "/persist");
    await new Promise((resolve, reject) => {
      pyodide.FS.syncfs(true, (err) => (err ? reject(err) : resolve()));
    });

    // Fetch every Python source file and write it into the virtual
    // filesystem at the same relative path the real project uses, so
    // `from app import create_app` and Jinja's template loader both work
    // completely unmodified.
    pyodide.FS.mkdirTree("/app");
    const appFiles = await (await fetch("/static/pwa/app-files.json")).json();
    for (const url of appFiles) {
      const rel = url.replace("/static/pwa/app_src/", "");
      const destPath = `/app/${rel}`;
      const dir = destPath.substring(0, destPath.lastIndexOf("/"));
      pyodide.FS.mkdirTree(dir);
      const res = await caches.match(url) || await fetch(url);
      const text = await res.text();
      pyodide.FS.writeFile(destPath, text);
    }
    pyodide.FS.mkdirTree("/pylibs");
    const backendRes = await caches.match("/static/pwa/pwa_backend.py") || await fetch("/static/pwa/pwa_backend.py");
    pyodide.FS.writeFile("/pylibs/pwa_backend.py", await backendRes.text());

    await pyodide.runPythonAsync(`
import sys
sys.path.insert(0, "/pylibs")
import pwa_backend
pwa_backend.boot(project_dir="/app", lib_dir="/pylibs")
`);
    return pyodide;
  })();
  return pyodideReadyPromise;
}

// ---------------------------------------------------------------------
// Fetch routing
// ---------------------------------------------------------------------
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin (e.g. CDN font) requests pass through normally

  if (isStaticAssetPath(url.pathname)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  event.respondWith(handleAppRequest(event.request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, res.clone());
    }
    return res;
  } catch (err) {
    return new Response("این فایل هنوز در حافظه آفلاین ذخیره نشده و اتصال اینترنت هم برقرار نیست.", { status: 504 });
  }
}

async function handleAppRequest(request) {
  const pyodide = await bootPyodideOnce();
  const url = new URL(request.url);
  const headersObj = {};
  request.headers.forEach((v, k) => { headersObj[k] = v; });
  const bodyBuf = ["GET", "HEAD"].includes(request.method) ? new ArrayBuffer(0) : await request.arrayBuffer();
  const bodyArr = new Uint8Array(bodyBuf);

  const handleFn = pyodide.globals.get("pwa_backend").handle;
  let resultProxy;
  try {
    resultProxy = handleFn(request.method, url.pathname + url.search, pyodide.toPy(headersObj), bodyArr);
  } catch (err) {
    return new Response(`خطای داخلی برنامه (آفلاین): ${err}`, { status: 500 });
  }
  const [status, headerPairs, bodyBytes] = resultProxy.toJs({ create_proxies: false });
  resultProxy.destroy();

  const respHeaders = new Headers();
  for (const [k, v] of headerPairs) respHeaders.set(k, v);

  // A POST/PUT/DELETE that succeeded may have changed the database -
  // flush the in-memory filesystem to IndexedDB so the change survives
  // closing the app. This runs after responding, so it never delays the UI.
  if (!["GET", "HEAD"].includes(request.method) && status < 400) {
    persistSoon(pyodide);
  }

  return new Response(bodyBytes, { status, headers: respHeaders });
}

let persistTimer = null;
function persistSoon(pyodide) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    pyodide.FS.syncfs(false, (err) => {
      if (err) console.error("PWA: خطا در ذخیره‌سازی داده در IndexedDB", err);
    });
  }, 400);
}
