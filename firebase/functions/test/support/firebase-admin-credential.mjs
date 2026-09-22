export function firebaseAdminCredentialFromEnvironment(env = process.env, clock = Date.now) {
  const accessToken = env.SIDEY_FIREBASE_ADMIN_ACCESS_TOKEN;
  const expiresAtValue = env.SIDEY_FIREBASE_ADMIN_ACCESS_TOKEN_EXPIRES_AT;
  if (!accessToken && !expiresAtValue) return undefined;

  const expiresAt = Number(expiresAtValue);
  const now = clock();
  if (typeof accessToken !== "string" || accessToken.length < 64 ||
      !Number.isSafeInteger(expiresAt) || expiresAt - now < 600_000) {
    throw new Error("invalid_firebase_admin_access_token");
  }

  return {
    async getAccessToken() {
      const expiresIn = Math.floor((expiresAt - clock()) / 1000);
      if (expiresIn < 60) throw new Error("expired_firebase_admin_access_token");
      return {access_token: accessToken, expires_in: expiresIn};
    },
  };
}
