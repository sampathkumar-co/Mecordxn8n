import test from "node:test";
import assert from "node:assert/strict";

import { renderHostCaddy } from "../scripts/render-host-caddy.mjs";

test("host Caddy snippet exposes only the approved public surface", () => {
  const rendered = renderHostCaddy({
    publicAppUrl: "https://mecord.example.test",
    controlApiHostPort: 18080,
    externalIngressUpstream: "mecordxn8n-control-api:8080",
  });

  assert.match(rendered, /^mecord\.example\.test \{/);
  assert.match(rendered, /reverse_proxy mecordxn8n-control-api:8080/);
  assert.match(rendered, />Content-Security-Policy/);
  assert.match(rendered, />X-Content-Type-Options "nosniff"/);
  assert.match(rendered, /handle \/ \{\s+redir \* \/console 302\s+\}/m);
  assert.match(rendered, /handle \/v1\/platform\/\*/);
  assert.match(rendered, /handle \/v1\/integrations\/webhooks\/\*/);
  assert.equal(rendered.includes("/metrics"), false);
  assert.equal(rendered.includes("/healthz"), false);
  assert.equal(rendered.includes("/v1/worker"), false);
  assert.match(rendered, /handle \{\s+respond 404\s+\}/m);
});

test("host Caddy renderer retains loopback mode for a host reverse proxy", () => {
  const rendered = renderHostCaddy({
    publicAppUrl: "https://mecord.example.test",
    controlApiHostPort: 18080,
  });
  assert.match(rendered, /reverse_proxy 127\.0\.0\.1:18080/);
});

test("host Caddy renderer rejects unsafe public URLs and upstreams", () => {
  assert.throws(
    () => renderHostCaddy({
      publicAppUrl: "http://mecord.example.test",
      controlApiHostPort: 18080,
    }),
    /canonical HTTPS/,
  );
  assert.throws(
    () => renderHostCaddy({
      publicAppUrl: "https://mecord.example.test:8443",
      controlApiHostPort: 18080,
    }),
    /origin-only canonical HTTPS/,
  );
  for (const publicAppUrl of [
    "https://mecord.example.test/subpath",
    "https://mecord.example.test/?debug=1",
    "https://mecord.example.test/#fragment",
    "https://user:pass@mecord.example.test/",
  ]) {
    assert.throws(
      () => renderHostCaddy({
        publicAppUrl,
        controlApiHostPort: 18080,
      }),
      /origin-only canonical HTTPS/,
    );
  }
  assert.throws(
    () => renderHostCaddy({
      publicAppUrl: "https://mecord.example.test",
      controlApiHostPort: 80,
    }),
    /1024 to 65535/,
  );
  for (const externalIngressUpstream of [
    "127.0.0.1:8080/path",
    "https://mecordxn8n-control-api:8080",
    "name:70000",
  ]) {
    assert.throws(
      () => renderHostCaddy({
        publicAppUrl: "https://mecord.example.test",
        controlApiHostPort: 18080,
        externalIngressUpstream,
      }),
      /EXTERNAL_INGRESS_UPSTREAM/,
    );
  }
});
