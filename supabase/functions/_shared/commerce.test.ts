import {
  checkoutPageURL,
  checkoutRedirectURL,
  CommerceConfigurationError,
  type CommerceEnvironmentReader,
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
    const checkout = new URL(checkoutPageURL(checkoutToken, fakeEnvironment({ SUPABASE_URL: backend })));
    assertEquals(checkout.searchParams.get("api"), expectedAPI);
    assertEquals(checkout.hash, `#token=${checkoutToken}`);
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
