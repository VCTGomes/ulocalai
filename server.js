#!/usr/bin/env node
/* U Local AI — minimal static server, no dependencies.
   Usage:  node server.js [port]      (default: 3140, or env PORT) */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.argv[2] || process.env.PORT || 3140);
const ROOT = path.join(__dirname, "public");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

http.createServer((req, res) => {
  // Only the path matters; the query string is ignored. Anything that escapes
  // ROOT after normalization is a traversal attempt and gets a 403.
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end("Forbidden"); return; }

  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA routes (/new, /chat/<id>) have no file behind them: anything that
      // looks like a page request gets the app shell, which then reads the URL.
      if (!path.extname(file)) {
        fs.readFile(path.join(ROOT, "index.html"), (e2, shell) => {
          if (e2) { res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found"); return; }
          res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" }).end(shell);
        });
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    // The HTML, the service worker and the manifest must never be cached by the
    // browser: a stale sw.js would keep serving an old app shell. Everything
    // else gets a short TTL — the service worker is what really caches it.
    const base = path.basename(file);
    const cache = (path.extname(file) === ".html" || base === "sw.js" || base === "manifest.json")
      ? "no-store" : "public, max-age=300";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": cache }).end(buf);
  });
}).listen(PORT, () => {
  console.log(`U Local AI → http://localhost:${PORT}`);
});
