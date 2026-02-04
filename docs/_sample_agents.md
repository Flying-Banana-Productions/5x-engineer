# Development Guidelines

## Service Architecture

- **Constructor DI required**: All DB-dependent services accept `db: Database` via constructor (direct param with default, or options object with lazy getter). Enables test DB injection.
- **Export pattern**: Services export the class, a factory function, and a default instance.
- **Error handling**: Catch DB errors and map to domain errors (`ConflictError`, `NotFoundError`) or fall back to defaults/env vars/cache. Never return raw database errors to clients; log internally and map to domain errors.
- **Transaction discipline**: Atomic operations use a transaction-threaded pattern end-to-end. Never claim atomicity while calling helpers that silently use a default connection or open their own transaction.

## Database Standards

- **Primary keys**: UUID (prefer UUIDv7 where established). Avoid integer PKs for tenant-scoped domain tables.
- **Timestamps**: `timestamptz` only (never bare `timestamp`). Store UTC, convert for display.
- **Multi-tenancy**: All tenant-scoped tables require `tenant_id`. Tenant context is required for all scoped reads/writes -- never default to "context missing -> allow all."
- **Migrations**: Forward-only. Never modify existing files; create new ones.

## Implementation Rules

- **Single Source of Truth (SSOT)**: Cross-layer features (API + web + docs) define a single canonical module for the contract (schemas/registry/constants). All consumers import from it. Never duplicate shared schemas, config registries, domain logic, or error-code tables.
- **Boundary invariants over UI guards**: Enforce "must never happen" conditions at service/API boundaries. UI protections are non-fatal fallbacks only -- render paths must not throw in ways that crash a screen.
- **No prompt-only enforcement**: Prompt guidance is never a security or UX boundary. Approval, confirmation, and role gating must be enforced in code.
- **Fail closed on sensitive surfaces**: Feature discovery, authorization, and "context missing" cases default to denying access. Dev-convenience fail-open requires an explicit env flag defaulted off.
- **PII-safe logging**: Never log raw user input, emails, or phones by default. Redact by key and by value-pattern (API keys, JWTs, bearer tokens). Debug raw logging requires explicit gating.
- **API contract drift**: When changing request/response shapes or headers, update the API spec and keep route coverage tests green.
- **DOM manipulation**: If using `document.querySelector`, scope to a container ref when possible to avoid cross-page collisions.

## Testing

- **Structure**: Unit tests mirror `src/`; integration tests group by feature.
- **Naming**: `.test.ts` suffix exclusively.
- **DB injection**: Use test database factories. Inject via constructor DI.
- **Data isolation**: Prefer UUID-based isolation. If a suite reuses fixed identifiers or shares global state, clean at the suite boundary (opt for patterns compatible with parallel tests).
- **Acceptance tests**: Every non-trivial phase ships with 1-2 deterministic acceptance tests proving the end-to-end contract -- not just unit coverage of helpers. AI/streaming tests use deterministic provider injection (no external keys).
- **Coverage**: 80% minimum enforced via config.

## TypeScript Safety

### Null Safety
- ORM `.returning()` calls yield a possibly-empty array. Always destructure then null-check before use.
- Array `[0]` access after `.length > 0` still needs `!` non-null assertion -- TS can't narrow indexing from length guards.

### Type Guards
- **Database errors**: Use a typed error interface in catch blocks -- never cast to `any`. Know your common DB error codes (unique violation, exclusion, serialization failure, deadlock).
- **JSON columns**: Use named interfaces -- never cast metadata to `any`.

### Conventions
- Prefix unused parameters with underscore (`_param`) to preserve API signatures without lint errors.
- Always `await` service methods returning `Promise<T>` -- no floating promises.
- Non-null assert (`!`) test helper returns when they throw on failure.

---

## Done Checklist (non-trivial work)

Before marking work complete, verify:

- [ ] **SSOT**: Contract defined once and reused; no duplicated tables across docs/server/web
- [ ] **Tests**: 1-2 deterministic acceptance tests proving the end-to-end contract
- [ ] **Boundaries**: Invariants enforced at API/service layer; client failures degrade gracefully
- [ ] **Security**: Auth enforced in services, not just prompts/filtering; tenant context required
- [ ] **Operability**: Correlation IDs propagate end-to-end; errors use stable domain codes; logs redacted by default
