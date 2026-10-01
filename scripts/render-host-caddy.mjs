import { pathToFileURL } from "node:url";

export function renderHostCaddy({
  publicAppUrl,
  controlApiHostPort,
  upstream,
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

  const resolvedUpstream = String(
    upstream || `127.0.0.1:${port}`,
  ).trim();
  const upstreamMatch = resolvedUpstream.match(
    /^([A-Za-z0-9][A-Za-z0-9_.-]*):(\d{1,5})$/,
  );
  if (!upstreamMatch) {
    throw new Error("HOST_CADDY_UPSTREAM must be host:port without a scheme");
  }
  const upstreamPort = Number(upstreamMatch[2]);
  if (upstreamPort < 1 || upstreamPort > 65535) {
    throw new Error("HOST_CADDY_UPSTREAM port is invalid");
  }

  return `${url.hostname} {
  encode zstd gzip
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Frame-Options "DENY"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
    Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    Cross-Origin-Opener-Policy "same-origin"
    Cross-Origin-Resource-Policy "same-origin"
    Content-Security-Policy "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'"
  }

  handle / {
    redir /console 302
  }

  handle /livez {
    reverse_proxy ${resolvedUpstream}
  }

  handle /console {
    reverse_proxy ${resolvedUpstream}
  }

  handle /console/* {
    reverse_proxy ${resolvedUpstream}
  }

  handle /v1/platform/* {
    reverse_proxy ${resolvedUpstream}
  }

  handle /v1/integrations/webhooks/* {
    reverse_proxy ${resolvedUpstream}
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
  process.stdout.write(
    renderHostCaddy({
      publicAppUrl: process.env.PUBLIC_APP_URL || process.argv[2],
      controlApiHostPort:
        process.env.CONTROL_API_HOST_PORT || process.argv[3],
      upstream:
        process.env.HOST_CADDY_UPSTREAM || process.argv[4],
    }),
  );
}
