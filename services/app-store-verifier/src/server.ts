import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createClient, type User } from "@supabase/supabase-js";
import { AppleGateway, sha256Hex, type VerifiedTransaction } from "./apple.js";
import { isSideyProductID } from "./catalog.js";
import { loadConfig } from "./config.js";
import { transactionRPCParameters } from "./transaction-parameters.js";

const config = loadConfig();
const apple = new AppleGateway(config);
const supabase = createClient(config.supabaseURL, config.supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

class HTTPError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readJSON(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 256 * 1024) throw new HTTPError(413, "request_too_large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HTTPError(400, "invalid_json");
  }
}

async function authenticatedUser(request: IncomingMessage): Promise<User> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) throw new HTTPError(401, "authentication_required");
  const token = authorization.slice("Bearer ".length);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new HTTPError(401, "invalid_session");
  return data.user;
}

async function applyTransaction(transaction: VerifiedTransaction, userID: string | null) {
  if (!isSideyProductID(transaction.productID)) {
    throw new HTTPError(400, "unknown_app_store_product");
  }
  const { data, error } = await supabase.rpc(
    "admin_apply_app_store_transaction", transactionRPCParameters(transaction, userID),
  );
  if (error) throw new Error(`database_transaction_rejected:${error.code ?? "unknown"}`);
  return Array.isArray(data) ? data[0] : data;
}

function sendJSON(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/health") {
    sendJSON(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/app-store/transactions") {
    const user = await authenticatedUser(request);
    const body = await readJSON(request);
    if (typeof body.signedTransactionInfo !== "string") {
      throw new HTTPError(400, "signed_transaction_required");
    }
    const transaction = await apple.verifyDeviceTransaction(body.signedTransactionInfo);
    const result = await applyTransaction(transaction, user.id);
    sendJSON(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/app-store/notifications") {
    const body = await readJSON(request);
    if (typeof body.signedPayload !== "string") {
      throw new HTTPError(400, "signed_payload_required");
    }
    const notification = await apple.verifyNotification(body.signedPayload);
    if (notification.transaction && isSideyProductID(notification.transaction.productID)) {
      await applyTransaction(notification.transaction, null);
    }
    const { error } = await supabase.rpc("admin_record_app_store_notification", {
      p_notification_uuid: notification.notificationUUID,
      p_notification_type: notification.notificationType,
      p_environment: notification.environment,
      p_transaction_id: notification.transaction?.transactionID ?? null,
      p_signed_at: new Date(notification.signedDate).toISOString(),
      p_payload_sha256_hex: sha256Hex(body.signedPayload),
      p_processing_status: notification.transaction ? "processed" : "ignored",
    });
    if (error) throw new Error(`database_notification_rejected:${error.code ?? "unknown"}`);
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/accounts/delete") {
    const user = await authenticatedUser(request);
    const body = await readJSON(request);
    if (typeof body.identityToken !== "string"
        || typeof body.authorizationCode !== "string"
        || typeof body.nonce !== "string") {
      throw new HTTPError(400, "apple_reauthentication_required");
    }
    const identity = await apple.verifyAppleIdentity(body.identityToken, body.nonce);
    const appleIdentity = user.identities?.find((candidate) => candidate.provider === "apple");
    const providerSubject = typeof appleIdentity?.identity_data?.sub === "string"
      ? appleIdentity.identity_data.sub
      : appleIdentity?.id;
    if (!providerSubject || providerSubject !== identity.subject) {
      throw new HTTPError(403, "apple_identity_mismatch");
    }
    const appleCredentialRevoked = await apple.revokeAuthorizationCode(
      body.authorizationCode,
      identity.subject,
    );
    const { error } = await supabase.auth.admin.deleteUser(user.id, false);
    if (error) throw new Error(`account_deletion_failed:${error.code ?? "unknown"}`);
    sendJSON(response, 200, { deleted: true, appleCredentialRevoked });
    return;
  }

  throw new HTTPError(404, "not_found");
}

const server = createServer((request, response) => {
  void route(request, response).catch((error: unknown) => {
    const status = error instanceof HTTPError ? error.status : 500;
    const message = error instanceof HTTPError ? error.message : "internal_error";
    if (status === 500) console.error("request_failed", error instanceof Error ? error.message : "unknown");
    sendJSON(response, status, { error: message });
  });
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`app_store_verifier_listening:${config.port}`);
});
