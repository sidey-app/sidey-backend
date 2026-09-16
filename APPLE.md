# App Store and Sign-In boundaries

App Store production configuration:
`APPLE_BUNDLE_ID`, `APPLE_APP_ID`, `APPLE_ROOT_CERTIFICATES` (comma-separated
certificate file paths), `APPLE_IAP_PRIVATE_KEY_FILE`, `APPLE_IAP_KEY_ID`,
`APPLE_IAP_ISSUER_ID`. Both Sandbox and Production use Apple SDK 5.2.0 chain,
signature, bundle/environment and online certificate checks. No Xcode/local
unsigned verifier is exposed. Missing configuration disables Apple endpoints.

Device submissions verify the client JWS, requery Apple's transaction API and
verify the server JWS again. Notifications verify the outer and embedded signed
payloads. Transaction IDs serialize within environment; account bindings and
grant projection commit together. Existing unbound transactions can be restored
after account deletion with the original appAccountToken, as in existing tests.
An unknown transaction requires the submitting user's appAccountToken.

Older signed state is ignored. Optional malformed money is decoded as unknown
without modifying the JWS used for signature verification; known money survives
later payloads without money. Internal `backfillPrices` only fills unknown money
and never changes the newer ownership/revocation state. Price is signed original
milliunits, without quantity multiplication or currency conversion.

Offer inclusion is snapshotted in `app_store_product_offers`; migration preserves
existing parent grants and their promises. Current solo offers do not acquire
historical bundle benefits. Restore does not automatically equip cosmetics.

Sign-In identity is separate. Apple-linked account deletion uses
`DELETE /api/account/apple` with fresh `identityToken`, challenge `nonce` and
`authorizationCode`. The linked subject must match. Set
`APPLE_SIGN_IN_CLIENT_ID`, `APPLE_SIGN_IN_KEY_ID`, `APPLE_SIGN_IN_TEAM_ID`, and
`APPLE_SIGN_IN_PRIVATE_KEY_FILE` for authorization exchange/revocation. As in the
existing verifier, account deletion completes even if external revocation fails,
and returns `appleCredentialRevoked=false`. No external credential is stored.

Local tests use deterministic provider data and exercise official verification
rejection plus optional-money decoding. The public test certificate is
[Apple Root CA G3](https://www.apple.com/certificateauthority/AppleRootCA-G3.cer),
SHA-256 `63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179`.
Successful real Apple API/JWS/OCSP calls require deployment credentials and are
deferred. See the [official Java SDK](https://github.com/apple/app-store-server-library-java).
