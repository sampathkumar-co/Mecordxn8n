import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const assetRoot = "web/console";
const allowedExtensions = new Set([".js", ".css"]);

async function listAssets(directory, prefix = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const name = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listAssets(path.join(directory, entry.name), name));
    } else if (entry.isFile() &&
      (allowedExtensions.has(path.extname(entry.name)) || name === "index.html")) {
      files.push(name);
    }
  }
  return files.sort();
}

function digest(value) {
  // GitHub/Linux and Windows CRLF checkouts represent the same source.
  const normalized = value.replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export async function verifyPublicAssets(baseUrl, {
  projectRoot = process.cwd(),
  fetchImpl = fetch,
} = {}) {
  const origin = new URL(baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.protocol !== "https:" && !(local && origin.protocol === "http:")) {
    throw new Error("Asset verification requires HTTPS except on local loopback");
  }
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Asset verification URL must be a plain origin");
  }
  const root = path.join(projectRoot, assetRoot);
  const files = await listAssets(root);
  if (files.length < 10) throw new Error("Expected console asset tree was not found");
  const failures = [];
  for (const file of files) {
    const expected = digest(await fs.readFile(path.join(root, file), "utf8"));
    const url = new URL(file === "index.html" ? "/console" : "/console/" + file, origin);
    try {
      const response = await fetchImpl(url, {
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 200) {
        failures.push({ file, reason: "HTTP " + response.status });
        continue;
      }
      const actual = digest(await response.text());
      if (actual !== expected) {
        failures.push({ file, reason: "content does not match release source" });
      }
    } catch (error) {
      failures.push({ file, reason: error?.message || "fetch failed" });
    }
  }
  return { ok: failures.length === 0, origin: origin.origin, checked: files.length, failures };
}

const direct = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  const base = process.env.PUBLIC_APP_URL || process.argv[2];
  if (!base) throw new Error("PUBLIC_APP_URL or URL argument is required");
  const result = await verifyPublicAssets(base);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
