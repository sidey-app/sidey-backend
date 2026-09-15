import { SUPPORTED_PRODUCT_IDS } from "./commerce-products.ts";
export { SUPPORTED_PRODUCT_IDS };
export const PORTONE_API_BASE = "https://api.portone.io";

export const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) {
    super(message);
  }
}

export class CommerceConfigurationError extends Error {
  constructor(readonly environmentName: string) {
    super(`missing_environment:${environmentName}`);
  }
}

export type CommerceOrder = {
  order_id: string;
  payment_id: string;
  product_id: string;
  display_name: string;
  character_id?: string;
  product_kind?: "character" | "bubble" | "throwable";
  catalog_item_id?: string;
  amount_krw: number;
  currency: string;
  customer_name?: string;
  policy_version?: string;
  policy_notice?: string;
  policy_consented_at?: string | null;
  payment_environment?: "test" | "live";
  order_status?: string;
};

export type PortOnePayment = {
  id: string;
  status: string;
  storeId: string;
  channel?: { key?: string; type?: string };
  version: string;
  transactionId?: string;
  amount: { total: number; cancelled?: number };
  currency: string;
  method?: { type?: string };
};

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new CommerceConfigurationError(name);
  return value;
}

export function supabaseURL(): string {
  return requiredEnvironment("SUPABASE_URL").replace(/\/$/, "");
}

function websitePageURL(path: string): URL {
  const base = Deno.env.get("SIDEY_WEBSITE_URL")?.trim()
    || "https://sidey-app.github.io/SIDEY/";
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CommerceConfigurationError("SIDEY_WEBSITE_URL");
  }
  return url;
}

function publicFunctionBaseURL(): string {
  const configured = Deno.env.get("SIDEY_PUBLIC_SUPABASE_URL")?.trim() || supabaseURL();
  const url = new URL(configured);
  if (url.hostname.toLowerCase() === "whtejsviizgejauasqqt.supabase.co") {
    throw new CommerceConfigurationError("SIDEY_PUBLIC_SUPABASE_URL");
  }
  url.pathname = "/functions/v1";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function checkoutPageURL(token: string): string {
  const url = websitePageURL("checkout/");
  url.searchParams.set("api", publicFunctionBaseURL());
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

export function checkoutResultURL(result: string, productID?: string): string {
  const url = websitePageURL("checkout-result/");
  url.searchParams.set("result", result);
  if (productID && SUPPORTED_PRODUCT_IDS.has(productID)) url.searchParams.set("product", productID);
  return url.toString();
}

export function checkoutRedirectURL(token: string, productID: string): string {
  const url = new URL(checkoutResultURL("complete", productID));
  url.searchParams.set("api", publicFunctionBaseURL());
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

export function portOneStoreID(): string {
  return requiredEnvironment("PORTONE_STORE_ID");
}

export function portOneChannelKey(): string {
  return requiredEnvironment("PORTONE_CHANNEL_KEY");
}

function portOneAPISecret(): string {
  return requiredEnvironment("PORTONE_API_SECRET");
}

export function portOneWebhookSecret(): string {
  return requiredEnvironment("PORTONE_WEBHOOK_SECRET");
}

export function assertPortOneConfiguration(): void {
  portOneStoreID();
  portOneChannelKey();
  portOneAPISecret();
  portOneWebhookSecret();
}

function serviceRoleKey(): string {
  return requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
}

function publishableKey(): string {
  return Deno.env.get("SUPABASE_ANON_KEY")?.trim()
    || requiredEnvironment("SIDEY_SUPABASE_PUBLISHABLE_KEY");
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function publicError(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse({ error: error.code, message: error.message }, error.status);
  }
  if (error instanceof CommerceConfigurationError) {
    console.error(error.message);
    return jsonResponse({
      error: "commerce_not_configured",
      message: "결제 서비스가 아직 준비되지 않았습니다.",
    }, 503);
  }
  console.error(error);
  return jsonResponse({ error: "internal_error", message: "요청을 처리하지 못했습니다." }, 500);
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function authenticatedUser(authorization: string | null): Promise<{ id: string }> {
  if (!authorization?.startsWith("Bearer ")) {
    throw new HttpError(401, "authentication_required", "SIDEY 로그인이 필요합니다.");
  }
  const response = await fetch(`${supabaseURL()}/auth/v1/user`, {
    headers: { authorization, apikey: publishableKey() },
  });
  if (!response.ok) {
    throw new HttpError(401, "authentication_required", "SIDEY 로그인이 만료되었습니다.");
  }
  const user = await response.json();
  if (typeof user?.id !== "string") throw new HttpError(401, "authentication_required");
  return { id: user.id };
}

async function rpc<T>(
  name: string,
  body: Record<string, unknown>,
  authorization: string,
  apiKey: string,
): Promise<T> {
  const response = await fetch(`${supabaseURL()}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { authorization, apikey: apiKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const code = typeof payload?.message === "string" ? payload.message : "database_error";
    const status = response.status === 401 || response.status === 403 ? 403 : 400;
    throw new HttpError(status, code, code);
  }
  return await response.json() as T;
}

export function userRPC<T>(name: string, body: Record<string, unknown>, authorization: string): Promise<T> {
  return rpc(name, body, authorization, publishableKey());
}

export function serviceRPC<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const key = serviceRoleKey();
  return rpc(name, body, `Bearer ${key}`, key);
}

export async function portOneRequest<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `PortOne ${portOneAPISecret()}`,
    "content-type": "application/json",
  };
  if (options.idempotencyKey) headers["Idempotency-Key"] = `"${options.idempotencyKey}"`;
  const response = await fetch(`${PORTONE_API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("PortOne request failed", response.status, payload?.type);
    throw new HttpError(502, "payment_provider_error", "결제사 응답을 확인하지 못했습니다.");
  }
  return payload as T;
}

export function validatePortOnePayment(
  payment: PortOnePayment,
  expected: CommerceOrder,
  requiredStatus?: string,
): PortOnePayment {
  const expectedChannelType = expected.payment_environment === "live" ? "LIVE" : "TEST";
  if (
    payment.id !== expected.payment_id
    || payment.storeId !== portOneStoreID()
    || payment.channel?.key !== portOneChannelKey()
    || payment.channel?.type !== expectedChannelType
    || payment.version !== "V2"
    || payment.amount?.total !== expected.amount_krw
    || payment.currency !== expected.currency
    || payment.method?.type !== "PaymentMethodEasyPay"
    || (requiredStatus !== undefined && payment.status !== requiredStatus)
  ) {
    throw new HttpError(409, "payment_verification_failed", "결제 정보가 주문과 일치하지 않습니다.");
  }
  return payment;
}

export async function applyPortOnePayment(
  order: CommerceOrder,
  payment: PortOnePayment,
  eventID: string,
  eventType: string,
  payloadHash?: string,
): Promise<string> {
  validatePortOnePayment(payment, order);
  const cancelled = payment.amount.cancelled ?? 0;
  const balance = payment.amount.total - cancelled;
  if (!Number.isSafeInteger(balance) || balance < 0) {
    throw new HttpError(409, "payment_verification_failed");
  }
  const hash = payloadHash ?? await sha256Hex(JSON.stringify(payment));
  return await serviceRPC<string>("commerce_record_portone_state", {
    p_event_id: eventID,
    p_event_type: eventType,
    p_payload_sha256_hex: hash,
    p_payment_id: payment.id,
    p_store_id: payment.storeId,
    p_channel_key: payment.channel?.key,
    p_portone_version: payment.version,
    p_channel_type: payment.channel?.type,
    p_amount_krw: payment.amount.total,
    p_balance_amount_krw: balance,
    p_currency: payment.currency,
    p_provider_status: payment.status,
    p_transaction_id: payment.transactionId ?? null,
    p_payment_method_type: "EASY_PAY",
    p_verified_at: new Date().toISOString(),
  });
}

export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256Hex(left), sha256Hex(right)]);
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |= leftHash.charCodeAt(index) ^ rightHash.charCodeAt(index);
  }
  return difference === 0;
}
