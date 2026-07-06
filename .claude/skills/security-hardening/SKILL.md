---
name: security-hardening
description: Use when writing code that touches authentication tokens, OAuth flows, webhooks, outbound HTTP to configurable URLs, URL/path construction from user input, shell command execution, regexes over user-supplied patterns, or security-relevant comparisons. Complements the tenant-isolation skill (which owns multi-tenant data boundaries).
---

# Security hardening

The non-tenant security defect classes reviewers and adversarial passes repeatedly confirmed. Tenant/RLS boundaries live in the tenant-isolation skill.

## Tokens, nonces, secrets

- OAuth/state nonces: assert unconditionally (missing = reject; a conditional check is structurally identical to no nonce) and consume atomically (`DELETE ... RETURNING`, null = reject). When flows at different permission levels share a nonce store, tag stored values with the issuing path so a low-permission nonce can't replay against a high-permission callback. Bind nonces to the issuing provider.
- `timingSafeEqual` throws on length mismatch — length-check first or an attacker gets a 500 oracle instead of a clean 401.
- Type-level "branded" approval tokens are forgeable unless backed by `unique symbol` at compile time AND server-side HMAC verification at runtime.
- Per-request unpredictable tokens in responses (CSP nonces) require `Cache-Control: private, no-store` — a cacheable response replays the nonce for the cache window.
- Never resolve credentials or user identity from LLM tool input or caller-supplied references — resolve the owning user from the authenticated resource record.
- Reject placeholder/sentinel values (all-zero hashes, epoch timestamps) at construction/parse time as a property of the value, not gated on environment.

## Outbound requests (SSRF family)

- Credentialed fetches to operator-configurable URLs validate at BOTH the write boundary (schema + public-URL assert at save) AND the dispatch boundary (re-validate + manual-redirect wrapper) — stored legacy rows never re-validate themselves.
- Redirect handling: treat cross-origin redirects as credential leaks when caller headers are present (reject cross-origin+headers); HTTPS-only on redirects unconditionally.
- Hostname comparisons use hostname, not `URL.host` (includes the port); domain matching is exact-or-dot-boundary — suffix matching (`endsWith("example.com")`) matches `evilexample.com`, the classic cookie-domain CVE.
- IP-literal blocklists must cover hex/short-form IPv4 encodings, not just dotted-quad.

## Injection surfaces

- URLs: never raw string concatenation of user values — `URLSearchParams` for query, `encodeURIComponent` per path segment, and encoding as a per-parameter contract (single- vs multi-segment paths differ). Note `encodeURIComponent('..')` is still `..` — path segments need explicit traversal rejection.
- Shell: argv-array execution (`execFileSync`/`spawnSync`) for ANY input not fully statically controlled; when hardening one interpolation site, sweep the whole file for sibling sites. A prefix-anchored regex is not input validation — the suffix remains attacker-influenceable. Command allowlists validate SHAPE (binary + subcommand + argument form, control-char rejection), not just the binary name.
- SQL fragments from config/factories: validate at construction time — identifiers against `/^[a-z][a-z0-9_]*$/`, predicates against structural shape (forbid semicolons, comment starters, quotes). Escape LIKE metacharacters in user-derived patterns.
- Object paths configured by operators: reject `__proto__`/`constructor` segments.
- Regexes built from user-supplied patterns need a ReDoS guard: cap input length before matching at minimum; better, validate against nested-quantifier shapes or run with a deadline — a catastrophic pattern stalls the event loop while holding transactions open.
- LLM prompts: text from users, documents, or prior LLM output interpolated into a subsequent prompt is an injection surface. Instructions go in the system channel; untrusted artifacts go in the user channel wrapped in a trust boundary with a treat-as-data directive. If downstream middleware truncates, the wrapper must survive truncation (escape `<`/`>` in the body so a sliced wrapper can't be broken out of; a code fence opened at the top loses its closing delimiter to the slice).

## Authorization shape

- Permission middleware in front of a fine-grained handler rule must grant a strict SUPERSET of every actor the handler admits — otherwise it rejects legitimate actors before the handler's rule runs. If the handler is the real gate, remove the redundant middleware.
- Read routes gate on the read permission key, write routes on the write key — uniform write-key application forces readers to hold write privileges.
- Symmetric enforcement across siblings: approve AND reject paths lock the row and validate item type identically; every endpoint in a family carries the same visibility gate — the one list/trace endpoint that skips it is the leak.
- Content awaiting a user's decision defaults to owner-only action; admin content-access and act-on-behalf are separate capabilities with an explicit audit story. Challenge any `isAdmin || isOwner` gate on user-content actions.
- Rate limits and input bounds ship WITH every new externally-reachable or LLM-calling surface: `.max()` on strings/arrays/durations, per-tenant limits on cheap-to-spam endpoints, and inclusion in existing per-run budget counters — new dispatch paths repeatedly bypass established ceilings.
- System-tier audit/telemetry tables (no tenant FK) must refuse raw tenant content — metadata only (counts, field names, shapes) with a per-writer redaction policy; "no tenant payload" is weaker than it sounds when evidence columns derive from tenant output.
