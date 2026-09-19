import {
  checkoutPageURL,
  checkoutRedirectURL,
  CommerceConfigurationError,
  HttpError,
  PORTONE_CHECKOUT_PAYMENT_METHOD,
  type CommerceOrder,
  type CommerceEnvironmentReader,
  type PortOnePayment,
  validatePortOnePayment,
  verifiedPortOnePaymentMethod,
} from "./commerce.ts";

const productionURL = "https://whtejsviizgejauasqqt.supabase.co";
const checkoutToken = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const productID = "character_starlight_upalupa";

function fakeEnvironment(values: Record<string, string>): CommerceEnvironmentReader {
  return (name) => values[name];
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function assertConfigurationError(action: () => unknown, environmentName: string): void {
  try {
    action();
  } catch (error) {
    if (error instanceof CommerceConfigurationError && error.environmentName === environmentName) return;
    throw error;
  }
  throw new Error(`Expected CommerceConfigurationError for ${environmentName}`);
}

function assertPaymentVerificationError(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    if (error instanceof HttpError && error.code === "payment_verification_failed") return;
    throw error;
  }
  throw new Error("Expected payment_verification_failed");
}

function paymentWithMethod(type: string): PortOnePayment {
  return {
    id: "payment-1",
    status: "PAID",
    storeId: "store-1",
    version: "V2",
    amount: { total: 1100 },
    currency: "KRW",
    method: { type },
  };
}

Deno.test("new checkouts use the KCP card payment window", () => {
  assertEquals(PORTONE_CHECKOUT_PAYMENT_METHOD, "CARD");
});

Deno.test("verified PortOne methods preserve card and legacy easy-pay records", () => {
  assertEquals(verifiedPortOnePaymentMethod(paymentWithMethod("PaymentMethodCard")), "CARD");
  assertEquals(verifiedPortOnePaymentMethod(paymentWithMethod("PaymentMethodEasyPay")), "EASY_PAY");
  assertEquals(verifiedPortOnePaymentMethod(paymentWithMethod("PaymentMethodTransfer")), undefined);
  assertEquals(
    verifiedPortOnePaymentMethod({ ...paymentWithMethod("ignored"), method: undefined }),
    undefined,
  );
});

Deno.test("PortOne card verification preserves every server-owned payment boundary", () => {
  const environment = fakeEnvironment({
    PORTONE_STORE_ID: "store-expected",
    PORTONE_CHANNEL_KEY: "channel-expected",
  });
  const expected: CommerceOrder = {
    order_id: "order-1",
    payment_id: "payment-1",
    product_id: "character_tree",
    display_name: "나무",
    amount_krw: 1100,
    currency: "KRW",
    payment_environment: "live",
  };
  const valid: PortOnePayment = {
    ...paymentWithMethod("PaymentMethodCard"),
    storeId: "store-expected",
    channel: { key: "channel-expected", type: "LIVE" },
  };

  assertEquals(validatePortOnePayment(valid, expected, "PAID", environment), valid);
  assertEquals(
    validatePortOnePayment(
      { ...valid, method: { type: "PaymentMethodEasyPay" } },
      expected,
      "PAID",
      environment,
    ).method?.type,
    "PaymentMethodEasyPay",
  );

  const mismatches: PortOnePayment[] = [
    { ...valid, id: "payment-other" },
    { ...valid, storeId: "store-other" },
    { ...valid, channel: { ...valid.channel, key: "channel-other" } },
    { ...valid, channel: { ...valid.channel, type: "TEST" } },
    { ...valid, version: "V1" },
    { ...valid, amount: { total: 2200 } },
    { ...valid, currency: "USD" },
    { ...valid, status: "FAILED" },
    { ...valid, method: { type: "PaymentMethodTransfer" } },
  ];
  for (const payment of mismatches) {
    assertPaymentVerificationError(() => validatePortOnePayment(payment, expected, "PAID", environment));
  }
});

Deno.test("production checkout omits an api query and preserves the token fragment", () => {
  const environment = fakeEnvironment({ SUPABASE_URL: productionURL });

  assertEquals(
    checkoutPageURL(checkoutToken, environment),
    `https://sidey-app.github.io/SIDEY/checkout/#token=${checkoutToken}`,
  );
  assertEquals(
    checkoutRedirectURL(checkoutToken, productID, environment),
    `https://sidey-app.github.io/SIDEY/checkout-result/?result=complete&product=${productID}#token=${checkoutToken}`,
  );
});

Deno.test("an explicit production function base also omits the api query", () => {
  const environment = fakeEnvironment({
    SUPABASE_URL: productionURL,
    SIDEY_PUBLIC_SUPABASE_URL: `${productionURL}/functions/v1/`,
  });

  assertEquals(
    checkoutPageURL(checkoutToken, environment),
    `https://sidey-app.github.io/SIDEY/checkout/#token=${checkoutToken}`,
  );
});

Deno.test("staging and loopback backends retain a normalized api query", () => {
  for (const [backend, expectedAPI] of [
    ["https://sidey-staging.supabase.co", "https://sidey-staging.supabase.co/functions/v1"],
    ["http://127.0.0.1:54321", "http://127.0.0.1:54321/functions/v1"],
  ]) {
    const environment = fakeEnvironment({
      SUPABASE_URL: backend,
      SIDEY_WEBSITE_URL: "https://checkout-dev.example.com/SIDEY/",
    });
    const checkout = new URL(checkoutPageURL(checkoutToken, environment));
    assertEquals(checkout.origin, "https://checkout-dev.example.com");
    assertEquals(checkout.searchParams.get("api"), expectedAPI);
    assertEquals(checkout.hash, `#token=${checkoutToken}`);
    const redirect = new URL(checkoutRedirectURL(checkoutToken, productID, environment));
    assertEquals(redirect.origin, "https://checkout-dev.example.com");
    assertEquals(redirect.searchParams.get("api"), expectedAPI);
    assertEquals(redirect.hash, `#token=${checkoutToken}`);
  }
});

Deno.test("nonproduction checkout requires an explicit development website", () => {
  for (const backend of ["https://sidey-staging.supabase.co", "http://127.0.0.1:54321"]) {
    const environment = fakeEnvironment({ SUPABASE_URL: backend });
    assertConfigurationError(() => checkoutPageURL(checkoutToken, environment), "SIDEY_WEBSITE_URL");
    assertConfigurationError(() => checkoutRedirectURL(checkoutToken, productID, environment), "SIDEY_WEBSITE_URL");
  }
});

Deno.test("nonproduction checkout cannot explicitly target the production website", () => {
  for (const backend of ["https://sidey-staging.supabase.co", "http://127.0.0.1:54321"]) {
    for (const website of [
      "https://sidey-app.github.io/SIDEY/",
      "https://SIDEY-APP.github.io/SIDEY",
      "https://sidey-app.github.io/",
    ]) {
      const environment = fakeEnvironment({ SUPABASE_URL: backend, SIDEY_WEBSITE_URL: website });
      assertConfigurationError(() => checkoutPageURL(checkoutToken, environment), "SIDEY_WEBSITE_URL");
      assertConfigurationError(() => checkoutRedirectURL(checkoutToken, productID, environment), "SIDEY_WEBSITE_URL");
    }
  }
});

Deno.test("loopback website development remains available over http", () => {
  const checkout = new URL(checkoutPageURL(checkoutToken, fakeEnvironment({
    SUPABASE_URL: "http://127.0.0.1:54321",
    SIDEY_WEBSITE_URL: "http://localhost:4321/SIDEY",
  })));

  assertEquals(checkout.origin, "http://localhost:4321");
  assertEquals(checkout.pathname, "/SIDEY/checkout/");
});

Deno.test("production cannot route its checkout token to a staging backend", () => {
  const environment = fakeEnvironment({
    SUPABASE_URL: productionURL,
    SIDEY_PUBLIC_SUPABASE_URL: "https://sidey-staging.supabase.co/functions/v1",
  });
  assertConfigurationError(() => checkoutPageURL(checkoutToken, environment), "SIDEY_PUBLIC_SUPABASE_URL");
});

Deno.test("unsafe public function bases are rejected", () => {
  const invalidValues = [
    "not a URL",
    "https://example.com",
    "http://sidey-staging.supabase.co",
    "https://sidey-staging.supabase.co:444",
    "https://user@sidey-staging.supabase.co",
    "https://sidey-staging.supabase.co?next=evil",
    "https://sidey-staging.supabase.co#fragment",
    "https://sidey-staging.supabase.co/unexpected",
  ];
  for (const publicURL of invalidValues) {
    assertConfigurationError(
      () => checkoutPageURL(checkoutToken, fakeEnvironment({
        SUPABASE_URL: productionURL,
        SIDEY_PUBLIC_SUPABASE_URL: publicURL,
      })),
      "SIDEY_PUBLIC_SUPABASE_URL",
    );
  }
});

Deno.test("unsafe backend function bases are rejected", () => {
  for (const backendURL of [
    "https://example.com",
    "https://sidey-staging.supabase.co/unexpected",
  ]) {
    assertConfigurationError(
      () => checkoutPageURL(checkoutToken, fakeEnvironment({ SUPABASE_URL: backendURL })),
      "SUPABASE_URL",
    );
  }
});

Deno.test("staging cannot publish a production checkout api", () => {
  assertConfigurationError(
    () => checkoutPageURL(checkoutToken, fakeEnvironment({
      SUPABASE_URL: "https://sidey-staging.supabase.co",
      SIDEY_PUBLIC_SUPABASE_URL: productionURL,
      SIDEY_WEBSITE_URL: "https://checkout-dev.example.com/SIDEY/",
    })),
    "SIDEY_PUBLIC_SUPABASE_URL",
  );
});

Deno.test("unsafe website bases are rejected before a checkout URL is returned", () => {
  for (const websiteURL of [
    "file:///tmp/sidey/",
    "http://sidey-app.github.io/SIDEY/",
    "https://sidey-app.github.io:444/SIDEY/",
    "https://user@sidey-app.github.io/SIDEY/",
    "https://sidey-app.github.io/SIDEY/?next=evil",
    "https://sidey-app.github.io/SIDEY/#fragment",
  ]) {
    assertConfigurationError(
      () => checkoutPageURL(checkoutToken, fakeEnvironment({
        SUPABASE_URL: productionURL,
        SIDEY_WEBSITE_URL: websiteURL,
      })),
      "SIDEY_WEBSITE_URL",
    );
  }
});
