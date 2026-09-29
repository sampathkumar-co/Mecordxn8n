import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../web/console",
);

const ASSETS = Object.freeze({
  "/console": ["index.html", "text/html; charset=utf-8"],
  "/console/": ["index.html", "text/html; charset=utf-8"],
  "/console/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/console/styles.css": ["styles.css", "text/css; charset=utf-8"],
});

function headers(contentType, html) {
  return {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "cache-control": html
      ? "no-store"
      : "public, max-age=300, must-revalidate",
  };
}

export async function serveConsoleAsset(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const asset = ASSETS[url.pathname];
  if (!asset) return false;

  const [file, contentType] = asset;
  const body = await fs.readFile(path.join(root, file));
  res.writeHead(200, {
    ...headers(contentType, file === "index.html"),
    "content-length": body.length,
  });
  if (req.method === "HEAD") return res.end();
  res.end(body);
  return true;
}
