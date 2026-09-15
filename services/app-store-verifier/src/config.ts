export interface ServiceConfig {
  port: number;
  supabaseURL: string;
  supabaseServiceRoleKey: string;
  appleBundleID: string;
  appleAppID: number;
  appleRootCAs: Buffer[];
  appleIAPIssuerID: string;
  appleIAPKeyID: string;
  appleIAPPrivateKey: string;
  appleSignInTeamID: string;
  appleSignInKeyID: string;
  appleSignInPrivateKey: string;
  appleSignInClientID: string;
}

function requireValue(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();
  if (!value) {
    throw new Error(`missing_environment:${key}`);
  }
  return value.replaceAll("\\n", "\n");
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const portValue = environment.PORT?.trim() || "8080";
  const port = Number(portValue);
  const appleAppID = Number(requireValue(environment, "APPLE_APP_ID"));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid_environment:PORT");
  }
  if (!Number.isSafeInteger(appleAppID) || appleAppID <= 0) {
    throw new Error("invalid_environment:APPLE_APP_ID");
  }

  const roots = requireValue(environment, "APPLE_ROOT_CA_BASE64")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Buffer.from(value, "base64"));
  if (roots.length === 0 || roots.some((root) => root.length === 0)) {
    throw new Error("invalid_environment:APPLE_ROOT_CA_BASE64");
  }

  const appleBundleID = requireValue(environment, "APPLE_BUNDLE_ID");
  if (appleBundleID !== "app.sidey.desktop.appstore") {
    throw new Error("invalid_environment:APPLE_BUNDLE_ID");
  }

  return {
    port,
    supabaseURL: requireValue(environment, "SUPABASE_URL"),
    supabaseServiceRoleKey: requireValue(environment, "SUPABASE_SERVICE_ROLE_KEY"),
    appleBundleID,
    appleAppID,
    appleRootCAs: roots,
    appleIAPIssuerID: requireValue(environment, "APPLE_IAP_ISSUER_ID"),
    appleIAPKeyID: requireValue(environment, "APPLE_IAP_KEY_ID"),
    appleIAPPrivateKey: requireValue(environment, "APPLE_IAP_PRIVATE_KEY"),
    appleSignInTeamID: requireValue(environment, "APPLE_SIGN_IN_TEAM_ID"),
    appleSignInKeyID: requireValue(environment, "APPLE_SIGN_IN_KEY_ID"),
    appleSignInPrivateKey: requireValue(environment, "APPLE_SIGN_IN_PRIVATE_KEY"),
    appleSignInClientID: requireValue(environment, "APPLE_SIGN_IN_CLIENT_ID"),
  };
}
