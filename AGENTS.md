# SIDEY private backend

This repository is private and owns all Supabase schema, RLS, Edge Functions,
App Store verification, database tests, and backend operations scripts.
Do not copy these sources back into the public SIDEY repository.

- Work on `shared/<topic>` branches; review and test before merging to `main`.
- Preserve the directory layout used by verifier and SQL tests.
- Applied migrations are immutable. Add forward-only migrations.
- Preserve membership checks, private Realtime authorization, idempotency,
  transaction locking, and the separation of Production and Sandbox.
- Never commit credentials, database exports, production logs, customer records,
  signed Apple payloads, or local Supabase linking state.
- Catalog snapshots originate in the public SIDEY asset catalog. Update their
  pinned source commit and regenerate both backend mirrors together.
- Run catalog checks, Python tests, download collector tests, verifier tests,
  and the isolated Database CI for affected changes.
- Public releases, production database migrations, service deployments and
  historical data backfills require explicit task authorization.
- Commit subjects use `type(Shared): 한국어 설명`. Preserve the human author and
  include `Co-authored-by: codex <codex@openai.com>` for Codex-assisted commits.
