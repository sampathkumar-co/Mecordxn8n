import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../web/console",
);

const SHELL_ROUTE = /^\/console(?:\/(?:home|launch|targets(?:\/[0-9a-f-]{36})?|findings(?:\/[0-9a-f-]{36})?|approvals(?:\/[0-9a-f-]{36})?|revenue|runs|integrations|workspace\/(?:access|audit)|operator))?\/?$/i;
const ASSET_PREFIXES = [
  "/console/core/",
  "/console/components/",
  "/console/views/",
  "/console/styles/",
];

const MIME = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
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

function assetFor(pathname) {
  if (SHELL_ROUTE.test(pathname)) {
    return { file: "index.html", contentType: MIME[".html"], html: true };
  }
  if (pathname === "/console/app.js") {
    return { file: "app.js", contentType: MIME[".js"], html: false };
  }
  if (pathname === "/console/styles.css") {
    return { file: "styles.css", contentType: MIME[".css"], html: false };
  }

  if (!ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return null;
  }

  const relative = pathname.slice("/console/".length);
  const normalized = path.posix.normalize(relative);
  if (
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.isAbsolute(normalized)
  ) {
    return null;
  }

  const extension = path.extname(normalized);
  const contentType = MIME[extension];
  if (!contentType) return null;

  return { file: normalized, contentType, html: false };
}

export async function serveConsoleAsset(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const asset = assetFor(url.pathname);
  if (!asset) return false;

  let body;
  try {
    body = await fs.readFile(path.join(root, asset.file));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  res.writeHead(200, {
    ...headers(asset.contentType, asset.html),
    "content-length": body.length,
  });
  if (req.method === "HEAD") return res.end();
  res.end(body);
  return true;
}
