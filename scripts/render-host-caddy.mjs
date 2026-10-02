import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

export function renderHostCaddy({
  publicAppUrl,
  controlApiHostPort,
  externalIngressUpstream,
}) {
  let url;
  try {
    url = new URL(String(publicAppUrl || "").trim());
  } catch {
    throw new Error("PUBLIC_APP_URL must be a valid URL");
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "PUBLIC_APP_URL must be an origin-only canonical HTTPS URL",
    );
  }
  if (!/^[a-z0-9.-]+$/i.test(url.hostname)) {
    throw new Error("PUBLIC_APP_URL hostname is invalid");
  }

  const port = Number(controlApiHostPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("CONTROL_API_HOST_PORT must be an integer from 1024 to 65535");
  }

  const candidate = String(externalIngressUpstream || "").trim();
  let upstream = `127.0.0.1:${port}`;
  if (candidate) {
    const match = candidate.match(/^([a-z0-9][a-z0-9_.-]*):(\d{1,5})$/i);
    if (!match) {
      throw new Error(
        "EXTERNAL_INGRESS_UPSTREAM must be a Docker DNS name and port",
      );
    }
    const upstreamPort = Number(match[2]);
    if (upstreamPort < 1 || upstreamPort > 65535) {
      throw new Error("EXTERNAL_INGRESS_UPSTREAM port is invalid");
    }
    upstream = candidate;
  }

  return `${url.hostname} {
  encode zstd gzip
  header {
    >Strict-Transport-Security "max-age=31536000; includeSubDomains"
    >X-Frame-Options "DENY"
    >X-Content-Type-Options "nosniff"
    >Referrer-Policy "no-referrer"
    >Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    >Cross-Origin-Opener-Policy "same-origin"
    >Cross-Origin-Resource-Policy "same-origin"
    >Content-Security-Policy "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'"
  }

  handle / {
    redir * /console 302
  }

  handle /livez {
    reverse_proxy ${upstream}
  }

  handle /console {
    reverse_proxy ${upstream}
  }

  handle /console/* {
    reverse_proxy ${upstream}
  }

  handle /v1/platform/* {
    reverse_proxy ${upstream}
  }

  handle /v1/integrations/webhooks/* {
    reverse_proxy ${upstream}
  }

  handle {
    respond 404
  }
}
`;
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const protectedEnvPath = ".deploy/production.env";
  const protectedEnv = fs.existsSync(protectedEnvPath)
    ? parseEnv(fs.readFileSync(protectedEnvPath, "utf8"))
    : {};

  process.stdout.write(
    renderHostCaddy({
      publicAppUrl:
        process.env.PUBLIC_APP_URL || protectedEnv.PUBLIC_APP_URL || process.argv[2],
      controlApiHostPort:
        process.env.CONTROL_API_HOST_PORT ||
        protectedEnv.CONTROL_API_HOST_PORT ||
        process.argv[3],
      externalIngressUpstream:
        process.env.EXTERNAL_INGRESS_UPSTREAM ||
        protectedEnv.EXTERNAL_INGRESS_UPSTREAM ||
        process.argv[4],
    }),
  );
}
