# Provider configuration and trust boundary

PortOne configuration is `PORTONE_API_SECRET`, `PORTONE_WEBHOOK_SECRET`,
`PORTONE_STORE_ID`, `PORTONE_CHANNEL_KEY`. Missing values disable purchases,
without disabling core chat. `SIDEY_COMMERCE_OPS_KEY` separately protects the
internal refund endpoint; Nginx must not expose `/internal/` to the Internet.
`SIDEY_WEBSITE_URL` and `SIDEY_WEBSITE_ORIGIN` configure checkout and exact CORS.

Create the singleton `commerce_runtime_settings` row with the reviewed policy
version/notice, selected test/live environment and sales initially disabled.
Enable sales only after provider verification. There is no public sales switch.
The importer preserves the existing policy and sales settings during cutover.

Authenticated REST provides catalog, entitlement projection, orders and status.
Checkout uses a 256-bit opaque 15-minute token (only its hash is stored), explicit
policy-version consent, and server-selected price/currency/environment. Webhook
signature verification uses pinned PortOne SDK 0.24.0; payment state is always
requeried from PortOne before it affects ownership. Refund retries reuse the
persisted request UUID and provider idempotency key, and requery cancellation.
Public callers cannot grant ownership or choose refund outcomes.

Orders imported with unknown payment environment cannot continue checkout;
create a fresh order. Historical facts are not inferred from today's settings.
Financial audit and source grants survive account deletion without user binding.
The effective entitlement projection preserves any remaining active source;
included items retain the parent grant's initial snapshot across updates.

Provider references: [official JVM SDK](https://github.com/portone-io/server-sdk/tree/main/jvm)
and [PortOne REST V2](https://developers.portone.io/api/rest-v2).
Production provider calls require real deployment credentials; deterministic
provider tests and official webhook signature tests run locally.
