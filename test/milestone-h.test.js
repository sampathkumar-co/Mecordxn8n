import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { dnsTxtMatches } from "../src/milestone-h/domain.js";
import {
  createStripeCheckout,
  createStripePortal,
  verifyStripeSignature,
} from "../src/milestone-h/billing.js";

test("DNS TXT ownership matching handles split TXT chunks exactly", () => {
  assert.equal(
    dnsTxtMatches(
      [["mecordxn8n-", "verification=abc"], ["other"]],
      "mecordxn8n-verification=abc",
    ),
    true,
  );
  assert.equal(
    dnsTxtMatches([["mecordxn8n-verification=abcd"]], "mecordxn8n-verification=abc"),
    false,
  );
});

test("Stripe webhook signatures require fresh matching v1 signature", () => {
  const secret = "whsec_test_signature_secret";
  const rawBody = Buffer.from('{"id":"evt_1"}');
  const timestamp = 1_800_000_000;
  const signature = createHmac("sha256", secret)
    .update(String(timestamp) + "." + rawBody.toString("utf8"))
    .digest("hex");
  assert.equal(
    verifyStripeSignature({
      rawBody,
      signatureHeader: "t=" + timestamp + ",v1=" + signature,
      secret,
      nowSeconds: timestamp + 20,
    }),
    true,
  );
  assert.equal(
    verifyStripeSignature({
      rawBody,
      signatureHeader: "t=" + timestamp + ",v1=" + signature,
      secret,
      nowSeconds: timestamp + 600,
    }),
    false,
  );
  assert.equal(
    verifyStripeSignature({
      rawBody,
      signatureHeader: "t=" + timestamp + ",v1=bad",
      secret,
      nowSeconds: timestamp,
    }),
    false,
  );
});

test("Stripe Checkout and Portal keep card handling at Stripe", async () => {
  const previous = {
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_PRICE_TEAM: process.env.STRIPE_PRICE_TEAM,
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
  };
  process.env.STRIPE_SECRET_KEY = "sk_test_runtime_secret";
  process.env.STRIPE_PRICE_TEAM = "price_team";
  process.env.PUBLIC_APP_URL = "https://app.example.test";

  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    const payload = url.endsWith("/checkout/sessions")
      ? { id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1", expires_at: 1800000300 }
      : { id: "bps_test_1", url: "https://billing.stripe.test/bps_test_1" };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const checkout = await createStripeCheckout({
      workspaceId: "00000000-0000-4000-8000-000000000111",
      plan: "TEAM",
      customerEmail: "buyer@example.test",
      fetchImpl: fakeFetch,
    });
    assert.equal(checkout.id, "cs_test_1");
    assert.match(checkout.url, /^https:\/\/checkout\.stripe\.test\//);
    const body = calls[0].options.body;
    assert.equal(body.get("mode"), "subscription");
    assert.equal(body.get("line_items[0][price]"), "price_team");
    assert.equal(body.get("metadata[workspace_id]"), "00000000-0000-4000-8000-000000000111");
    assert.equal(
      calls[0].options.headers.Authorization,
      "Bearer sk_test_runtime_secret",
    );

    const portal = await createStripePortal({
      customerId: "cus_test_1",
      fetchImpl: fakeFetch,
    });
    assert.equal(portal.id, "bps_test_1");
    assert.equal(calls[1].options.body.get("customer"), "cus_test_1");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
