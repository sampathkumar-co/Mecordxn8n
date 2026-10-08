import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../web/console",
);

const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
});

function headers(contentType, html) {
  return {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    "cache-control": html
      ? "no-store"
      : "public, max-age=300, must-revalidate",
  };
}

function resolveConsoleFile(pathname) {
  if (pathname === "/console" || pathname === "/console/") {
    return { file: "index.html", html: true };
  }
  if (!pathname.startsWith("/console/")) return null;

  let relative;
  try {
    relative = decodeURIComponent(pathname.slice("/console/".length));
  } catch {
    return null;
  }

  if (
    !relative ||
    relative.includes("\0") ||
    relative.includes("\\") ||
    relative.split("/").some((part) => part.startsWith("."))
  ) {
    return null;
  }

  const extension = path.extname(relative).toLowerCase();
  if (!extension) {
    // History-API route: target/finding/approval/etc. detail pages all use
    // the same authenticated console shell.
    return { file: "index.html", html: true };
  }
  if (!CONTENT_TYPES[extension]) return null;

  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep)) return null;
  return { file: relative, html: extension === ".html" };
}

export async function serveConsoleAsset(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const asset = resolveConsoleFile(url.pathname);
  if (!asset) return false;

  const extension = path.extname(asset.file).toLowerCase();
  const contentType = CONTENT_TYPES[extension] || "application/octet-stream";

  let body;
  try {
    body = await fs.readFile(path.join(root, asset.file));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  res.writeHead(200, {
    ...headers(contentType, asset.html),
    "content-length": body.length,
  });
  if (req.method === "HEAD") return res.end();
  res.end(body);
  return true;
}
