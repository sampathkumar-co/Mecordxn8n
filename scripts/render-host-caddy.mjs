import { pathToFileURL } from "node:url";

export function renderHostCaddy({
  publicAppUrl,
  controlApiHostPort,
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
    reverse_proxy 127.0.0.1:${port}
  }

  handle /console {
    reverse_proxy 127.0.0.1:${port}
  }

  handle /console/* {
    reverse_proxy 127.0.0.1:${port}
  }

  handle /v1/platform/* {
    reverse_proxy 127.0.0.1:${port}
  }

  handle /v1/integrations/webhooks/* {
    reverse_proxy 127.0.0.1:${port}
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
    }),
  );
}
