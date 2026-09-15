import {
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
  type JWSTransactionDecodedPayload,
} from "@apple/app-store-server-library";
import nodeFetch, { type RequestInit } from "node-fetch";
import { createHash } from "node:crypto";
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from "jose";
import type { ServiceConfig } from "./config.js";

const appleJWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

export interface VerifiedTransaction {
  transactionID: string;
  originalTransactionID: string;
  productID: string;
  appAccountToken: string | null;
  environment: "Sandbox" | "Production";
  purchaseDate: number;
  revocationDate: number | null;
  signedDate: number;
  signedTransactionInfo: string;
  priceMilliunits: number | null;
  currency: string | null;
}

/** Abort covers fetching headers AND reading a stalled response body. */
export function fetchAppleBackfill(url: string, init: RequestInit, timeoutMS = 15_000) {
  // node-fetch v2 accepts native AbortSignal; its legacy optional event types differ.
  const signal = AbortSignal.timeout(timeoutMS) as unknown as NonNullable<RequestInit["signal"]>;
  return nodeFetch(url, { ...init, signal });
}

class BackfillAppleClient extends AppStoreServerAPIClient {
  constructor(config: ServiceConfig, private readonly targetEnvironment: "Production" | "Sandbox") {
    super(config.appleIAPPrivateKey, config.appleIAPKeyID, config.appleIAPIssuerID,
      config.appleBundleID, targetEnvironment === "Production" ? Environment.PRODUCTION : Environment.SANDBOX);
  }

  protected override makeFetchRequest(path: string, query: URLSearchParams, method: string,
    body: string | Buffer | undefined, headers: Record<string, string>) {
    const origin = this.targetEnvironment === "Production"
      ? "https://api.storekit.itunes.apple.com" : "https://api.storekit-sandbox.itunes.apple.com";
    return fetchAppleBackfill(`${origin}${path}?${query}`, { method, headers, ...(body === undefined ? {} : { body }) });
  }
}

export class AppleGateway {
  private readonly productionVerifier: SignedDataVerifier;
  private readonly sandboxVerifier: SignedDataVerifier;
  private readonly productionClient: AppStoreServerAPIClient;
  private readonly sandboxClient: AppStoreServerAPIClient;

  constructor(private readonly config: ServiceConfig) {
    this.productionVerifier = new SignedDataVerifier(
      config.appleRootCAs,
      true,
      Environment.PRODUCTION,
      config.appleBundleID,
      config.appleAppID,
    );
    this.sandboxVerifier = new SignedDataVerifier(
      config.appleRootCAs,
      true,
      Environment.SANDBOX,
      config.appleBundleID,
      undefined,
    );
    this.productionClient = new AppStoreServerAPIClient(
      config.appleIAPPrivateKey,
      config.appleIAPKeyID,
      config.appleIAPIssuerID,
      config.appleBundleID,
      Environment.PRODUCTION,
    );
    this.sandboxClient = new AppStoreServerAPIClient(
      config.appleIAPPrivateKey,
      config.appleIAPKeyID,
      config.appleIAPIssuerID,
      config.appleBundleID,
      Environment.SANDBOX,
    );
  }

  async verifyDeviceTransaction(signedTransactionInfo: string): Promise<VerifiedTransaction> {
    const firstPass = await this.verifyTransactionInEitherEnvironment(signedTransactionInfo);
    const client = firstPass.environment === "Production"
      ? this.productionClient
      : this.sandboxClient;
    const response = await client.getTransactionInfo(firstPass.transactionID);
    if (!response.signedTransactionInfo) {
      throw new Error("apple_transaction_missing");
    }
    const serverTransaction = await this.verifyTransaction(
      response.signedTransactionInfo,
      firstPass.environment,
    );
    if (serverTransaction.transactionID !== firstPass.transactionID) {
      throw new Error("apple_transaction_mismatch");
    }
    return serverTransaction;
  }

  async verifyNotification(signedPayload: string): Promise<{
    notificationUUID: string;
    notificationType: string;
    signedDate: number;
    transaction: VerifiedTransaction | null;
    environment: "Sandbox" | "Production";
  }> {
    for (const environment of ["Production", "Sandbox"] as const) {
      try {
        const verifier = environment === "Production"
          ? this.productionVerifier
          : this.sandboxVerifier;
        const decoded = await verifier.verifyAndDecodeNotification(signedPayload);
        if (!decoded.notificationUUID || !decoded.notificationType || !decoded.signedDate) {
          throw new Error("invalid_apple_notification");
        }
        const signedTransaction = decoded.data?.signedTransactionInfo;
        return {
          notificationUUID: decoded.notificationUUID,
          notificationType: decoded.notificationType,
          signedDate: decoded.signedDate,
          transaction: signedTransaction
            ? await this.verifyTransaction(signedTransaction, environment)
            : null,
          environment,
        };
      } catch (error) {
        if (environment === "Sandbox") throw error;
      }
    }
    throw new Error("invalid_apple_notification");
  }

  private async verifyTransactionInEitherEnvironment(
    signedTransactionInfo: string,
  ): Promise<VerifiedTransaction> {
    try {
      return await this.verifyTransaction(signedTransactionInfo, "Production");
    } catch {
      return this.verifyTransaction(signedTransactionInfo, "Sandbox");
    }
  }

  private async verifyTransaction(
    signedTransactionInfo: string,
    environment: "Sandbox" | "Production",
  ): Promise<VerifiedTransaction> {
    const verifier = environment === "Production"
      ? this.productionVerifier
      : this.sandboxVerifier;
    const decoded = await verifier.verifyAndDecodeTransaction(signedTransactionInfo);
    return mapVerifiedTransaction(decoded, signedTransactionInfo, environment);
  }

  async getVerifiedTransaction(
    transactionID: string,
    environment: "Sandbox" | "Production",
  ): Promise<VerifiedTransaction> {
    const client = new BackfillAppleClient(this.config, environment);
    const response = await client.getTransactionInfo(transactionID);
    if (!response.signedTransactionInfo) throw new Error("apple_transaction_missing");
    const transaction = await this.verifyTransaction(response.signedTransactionInfo, environment);
    if (transaction.transactionID !== transactionID) throw new Error("apple_transaction_mismatch");
    return transaction;
  }

  async verifyAppleIdentity(
    identityToken: string,
    rawNonce: string,
  ): Promise<{ subject: string }> {
    const expectedNonce = createHash("sha256").update(rawNonce).digest("hex");
    const result = await jwtVerify(identityToken, appleJWKS, {
      issuer: "https://appleid.apple.com",
      audience: this.config.appleSignInClientID,
    });
    if (!result.payload.sub || result.payload.nonce !== expectedNonce) {
      throw new Error("invalid_apple_identity");
    }
    return { subject: result.payload.sub };
  }

  async revokeAuthorizationCode(authorizationCode: string, expectedSubject: string): Promise<boolean> {
    try {
      const clientSecret = await this.makeSignInClientSecret();
      const tokenResponse = await fetch("https://appleid.apple.com/auth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.config.appleSignInClientID,
          client_secret: clientSecret,
          code: authorizationCode,
          grant_type: "authorization_code",
        }),
      });
      if (!tokenResponse.ok) return false;
      const tokenBody = await tokenResponse.json() as { refresh_token?: string; id_token?: string };
      if (!tokenBody.refresh_token || !tokenBody.id_token) return false;
      const exchangedIdentity = await jwtVerify(tokenBody.id_token, appleJWKS, {
        issuer: "https://appleid.apple.com",
        audience: this.config.appleSignInClientID,
      });
      if (exchangedIdentity.payload.sub !== expectedSubject) return false;

      const revokeResponse = await fetch("https://appleid.apple.com/auth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.config.appleSignInClientID,
          client_secret: clientSecret,
          token: tokenBody.refresh_token,
          token_type_hint: "refresh_token",
        }),
      });
      return revokeResponse.ok;
    } catch {
      return false;
    }
  }

  private async makeSignInClientSecret(): Promise<string> {
    const key = await importPKCS8(this.config.appleSignInPrivateKey, "ES256");
    const now = Math.floor(Date.now() / 1_000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.config.appleSignInKeyID })
      .setIssuer(this.config.appleSignInTeamID)
      .setSubject(this.config.appleSignInClientID)
      .setAudience("https://appleid.apple.com")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(key);
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Call only after Apple's signature, bundle and environment verification succeeds. */
export function mapVerifiedTransaction(
  decoded: JWSTransactionDecodedPayload,
  signedTransactionInfo: string,
  environment: "Sandbox" | "Production",
): VerifiedTransaction {
  if (!decoded.transactionId || !decoded.originalTransactionId || !decoded.productId
      || !decoded.purchaseDate || !decoded.signedDate) {
    throw new Error("invalid_apple_transaction");
  }
  // Optional financial fields must not block valid purchases. Preserve unknown as null,
  // including malformed or incomplete pairs, rather than inventing catalog prices.
  const validPrice = typeof decoded.price === "number"
    && Number.isSafeInteger(decoded.price) && decoded.price >= 0
    && typeof decoded.currency === "string" && /^[A-Z]{3}$/.test(decoded.currency);
  return {
    transactionID: decoded.transactionId,
    originalTransactionID: decoded.originalTransactionId,
    productID: decoded.productId,
    appAccountToken: decoded.appAccountToken ?? null,
    environment,
    purchaseDate: decoded.purchaseDate,
    revocationDate: decoded.revocationDate ?? null,
    signedDate: decoded.signedDate,
    signedTransactionInfo,
    priceMilliunits: validPrice ? decoded.price! : null,
    currency: validPrice ? decoded.currency! : null,
  };
}
