# Munshi — E2EE Plan

Design plan for end-to-end encryption. Researched August 2026 against prior
art: ente (key management), Actual Budget (finance CRDT sync), secsync
(encrypted snapshots), Standard Notes / Notesnook (E2EE over ordinary auth),
1Password / Bitwarden (device unlock, sharing, revocation).

Hard constraints this plan satisfies:

1. **We cannot view data** — server holds ciphertext + minimal sync metadata only.
2. **No plaintext at rest anywhere** — not in Postgres, not on disk server-side;
   client replicas live in browser/OS storage, encrypted server copy is the
   durable one.
3. **Password required to open** — an encryption passphrase, separate from
   login, never transmitted.
4. **MCP works seamlessly** — a local MCP server inside the trust boundary,
   same client library as the app.
5. **Analytics still work** — all math runs client-side; cross-ledger
   dashboards read client-computed encrypted rollup blobs.

---

## 1. Architecture in one picture

```
            Supabase (ciphertext only)
  ┌─────────────────────────────────────────────┐
  │ users_keys      (wrapped master key, pubkey)│
  │ ledger_keys    (ledgerKey sealed per member)│
  │ sync_ops   (seq, epoch, ciphertext, device) │
  │ snapshots     (epoch, encrypted checkpoint) │
  │ rollups   (encrypted derived monthly blobs) │
  │ auth / RLS / realtime pings     (unchanged) │
  └───────────────▲─────────────────────────────┘
                  │ encrypted ops + blobs only
┌─────────────────┴── user device (trust boundary) ──────────┐
│ @munshi/core — headless TS client:                         │
│   keys · crypto · sync · local SQLite replica · calc.ts    │
│        ▲                    ▲                    ▲         │
│   Next.js web app      mobile apps        munshi MCP server│
│   (wa-sqlite OPFS)     (SQLite+Keychain)  (stdio, local)   │
└────────────────────────────────────────────────────────────┘
```

Server's only jobs: auth, membership/ACL, op sequencing + fanout, ciphertext
storage, realtime "something changed" pings, backups. It can never decrypt.

## 2. Key hierarchy (ente pattern)

```
passphrase ──argon2id──▶ KEK                      never leaves device
KEK ──XChaCha20-Poly1305──▶ encryptedMasterKey    stored on server
masterKey (random 256-bit) ─┬─▶ wraps X25519 privateKey  (publicKey plaintext on server)
                            ├─▶ wraps recoveryKey        (mutual: each encrypts the other)
                            └─▶ wraps each ledgerKey     (random symmetric key per ledger)
ledgerKey (versioned v1,v2…) ──▶ encrypts every op/snapshot/rollup for that ledger
sharing: ledgerKey sealed to each member's publicKey (X25519 sealed box)
```

Decisions:

- **Passphrase is encryption-only.** Supabase OTP/OAuth login stays exactly
  as-is and gates *ciphertext* access; the passphrase gates *plaintext*. It
  is never sent anywhere — correctness check is "AEAD tag verifies when
  unwrapping encryptedMasterKey" (Standard Notes pattern). No OPAQUE — adds
  complexity, buys nothing when the password never travels.
- **KDF**: Argon2id, m=64 MiB, t=3, p=1, 16-byte salt, run in a Web Worker;
  params stored per-user server-side so they can be migrated later.
- **Password change = rewrap only** (re-encrypt 32-byte masterKey). Never
  re-encrypts data. This indirection is the whole point of the KEK.
- **Recovery**: mandatory at setup — recoveryKey shown as a 24-word BIP-39
  mnemonic + printable PDF kit with QR. Recovery flow: mnemonic → unwrap
  masterKey → set new passphrase → rewrap. Lose both passphrase and kit ⇒
  data is gone; the UI says so plainly. Future nicety: shared-ledger
  co-members can re-share ledgerKeys after a locked-out member re-onboards.
- **Crypto stack**: noble family — `@noble/hashes` (argon2id, HKDF),
  `@noble/curves` (X25519 sealed box), `@noble/ciphers`
  (XChaCha20-Poly1305), `@scure/bip39`. Pure TS, audited (hashes/curves),
  identical code on web and React Native — no WASM, no native bindings.
  libsodium *semantics*, noble *implementation*.

## 3. Unlock UX (don't retype the passphrase daily)

- **Web**: after first unlock, generate a non-extractable WebCrypto AES-GCM
  device key in IndexedDB; store masterKey encrypted under it. Next visit:
  valid Supabase session + device key ⇒ silent unlock. XSS can use but not
  exfiltrate the key. "Lock" clears the in-memory key; "forget device"
  deletes the wrapped copy.
- **Passkey unlock** (progressive enhancement): WebAuthn PRF extension —
  prfOutput → HKDF → wraps masterKey. Chrome/Edge/Android solid, Safari 18+
  supports PRF with iCloud passkeys, Windows Hello since Feb 2026.
  Passphrase remains the universal path.
- **Mobile**: masterKey in Keychain (`WhenUnlockedThisDeviceOnly`) / Android
  Keystore behind biometrics. Biometric is an access gate, not crypto — the
  anchor stays the passphrase-wrapped server copy.

## 4. Sync: encrypted oplog + snapshots (Actual + secsync)

- **Local replica is the working store**: full plaintext SQLite on device —
  wa-sqlite `OPFSCoopSyncVFS` in a Web Worker on web (IndexedDB VFS
  fallback for Safari private mode), op-sqlite/expo-sqlite on mobile.
  Request `navigator.storage.persist()`; regardless, the browser replica is
  a *cache* — the encrypted server log is the durable copy, and
  re-hydration (snapshot + tail ops) must always work.
- **Every mutation = one logical op**, encoded client-side, encrypted with
  the ledgerKey, appended to `sync_ops`. Ops carry a **Hybrid Logical
  Clock** inside the ciphertext; the server's `bigserial seq` is transport
  order only. Ops encode *whole financial operations* ("create entry" with
  all balanced postings, "rewrite entry", "reconcile account") — never bare
  field writes — so double-entry invariants can't be torn by merge.
  Field-level LWW applies within an entity on concurrent edits; deletes are
  tombstones; **balances are never synced, always recomputed locally**
  (calc.ts already works this way).
- **Snapshots**: client periodically uploads an encrypted checkpoint of the
  whole ledger (few MB at most); ops reference the snapshot epoch. New
  device = latest snapshot + tail ops, not full history replay. Server GCs
  ops older than the oldest snapshot every device has acked. Built in from
  day one (Actual's manual "reset sync" is the cautionary tale).
- **Versioning**: every op and snapshot carries a schema version; the
  server can't migrate ciphertext, so clients keep decoders for old
  versions or bump the epoch on breaking change.
- **Supabase stays the backend.** `sync_ops` / `snapshots` / `rollups`
  tables, RLS by ledger membership (unchanged model), bigserial for
  sequencing, Realtime broadcast as a "pull now" ping (ping, not payload).
  No new infrastructure. Nonce discipline: random 24-byte XChaCha20 nonces;
  AAD binds ledger id + epoch + seq so the server can't reorder/splice
  undetected.

## 5. Sharing & revocation

- **Invite (deferred wrap)**: invite row `{ledger_id, email, role, pending}`
  — no secrets in it. Invitee signs up, sets passphrase, publishes
  publicKey; an existing member's client then seals the ledgerKey to that
  publicKey and membership activates. (Bitwarden's "confirm member" step,
  automated.)
- **Revoke**: delete wrapped key + ACL immediately (stops API access), and
  rotate ledgerKey **forward-only**: new entries encrypt under
  ledgerKey_v(n+1), wrapped for remaining members; old entries stay under
  old versions (the removed member already saw them — 1Password/ente take
  the same stance). Full re-encrypt exists only as an explicit "paranoid
  rotate" action.
- **Attribution** (Vision §3): each op records author user id — comes free
  with the oplog.

## 6. MCP: one URL, everything in the chat

Product decision: **MCP is a single hosted URL** —
`https://mcp.munshi.manzer.in/mcp` (Streamable HTTP, OAuth 2.1). The user
pastes it into claude.ai or Claude Code and every action — reads, entries,
plans, analytics, reconciliation — happens in the conversation. No CLI, no
local install, no app visits per action.

Background research verdict stands: a hosted server cannot serve E2EE data
without being *granted* a key. So the key grant is built into the OAuth
consent itself, per ledger, honestly surfaced (see 6.2).

### 6.1 Connect flow (one-time, inside OAuth)

1. User adds the MCP URL in claude.ai → OAuth 2.1 (PKCE) kicks off → browser
   opens the Munshi consent page.
2. Consent page = the web app's own client code: Supabase login (or existing
   session) + passphrase prompt (or silent device-key unlock, §3). The
   masterKey is unwrapped **in the browser** — the passphrase never travels.
3. Page lists ledgers with checkboxes: "Let AI read & write: Personal ☑
   Company ☐". For each checked ledger the browser seals that ledgerKey to
   the MCP service's public key (mechanically identical to adding a member)
   and uploads the wrapped key.
4. OAuth completes; Claude holds a token scoped to that user + those
   ledgers. From here on, everything lives in the chat.

Managing the grant later = the same settings page: add/remove ledgers,
revoke entirely. Grants expire (re-consent every 90 days, configurable).

### 6.2 Service-side custody (minimize what "hosted" costs)

- Service keypair lives in KMS; wrapped ledgerKeys in Postgres. Per request:
  unwrap in memory, sync + decrypt the ledger's oplog into an in-memory
  replica (`@munshi/core`, same brain), serve the tool call, drop plaintext.
  Nothing decrypted ever touches disk.
- **Honest boundary**: a consented ledger is readable by the Munshi service
  — that is inherent to "all actions via a hosted URL". Constraint 1 ("we
  cannot view data") holds absolutely for un-consented ledgers only. The
  app badges consented ledgers ("cloud AI can read this"); the security
  page says it verbatim. Revoke = delete wrapped key + forward key rotation
  (§5).
- Sensitive books stay un-consented and remain fully E2EE — per-ledger
  granularity is the whole point of ledger-scoped keys.

### 6.3 Tool surface & write safety

Mirrors Vision §1 "AI proposes, user confirms":

- Every read tool `readOnlyHint: true`; no generic run_sql tool.
- **Two-phase writes**: `plan_changes(ops[]) → {change_set_id, diff, totals
  before/after}` then `apply_changes(change_set_id)` — the id is the
  idempotency key, expires in minutes; destructive ops additionally gated
  by a boolean elicitation confirm (works in claude.ai).
- Every MCP mutation logged with `source: "mcp"` + OAuth client — auditable
  and undoable in the app; op attribution comes free from the oplog (§5).
- The in-app AI chat uses the same `@munshi/core` mutation API — one brain,
  all callers.

### 6.4 Optional power-user modes (later, not v1)

- **Local stdio server** (`npx @munshi/mcp`): plaintext never leaves the
  device; key via OS keychain after a one-time login. For Claude
  Code/Desktop users who refuse the cloud grant.
- **Self-hosted bridge**: same server exposed via the user's own tunnel —
  claude.ai connects to the user's endpoint, E2EE fully intact.
- Attested enclave — deferred (see §10).

## 7. Analytics under E2EE

All ledger math already lives in pure TS (calc.ts) — it moves wholly
client-side; the SQL views (`account_balances`, `card_cycle_balances`)
retire into it.

- **Within a ledger**: full analytics with zero compromise — the client has
  the complete plaintext replica. Category trends, projections, budgets,
  burn rate (Vision §6) are local queries over local SQLite. Faster than
  today (no network round-trip).
- **Cross-ledger dashboard**: each client computes small monthly rollups per
  ledger (net worth point, category totals, upcoming dues, liquidity),
  encrypts them under the ledgerKey, uploads as `rollups` blobs. The
  dashboard downloads ~dozens of tiny blobs, decrypts with the keys the
  user holds, aggregates locally. Server never sees a number.
- **Recompute rule**: rollups are derived data — regenerated after local
  mutations and on snapshot upload; never trusted as source of truth.
- **AI insights**: consented-slice tier (Vision §4) — client decrypts the
  relevant scope, sends to the LLM over TLS with explicit per-conversation
  consent. On-device parsing for mobile capture stays fully E2EE.

## 8. What the server still sees (honest boundary)

Deliberate structural metadata only: user emails, ledger ids and member
lists/roles, op sequence numbers and sizes, device ids, timestamps, KDF
params, public keys. Never: amounts, names, descriptions, account
structure, categories. This list goes verbatim into the product's security
page — the E2EE promise is only as good as its honesty (Actual's plaintext
bank-token surprise is the anti-pattern).

## 9. Build order

Prerequisite refactor (valuable even before any crypto ships):

0. **Extract `@munshi/core`** — headless TS package: types, calc.ts,
   postings.ts, one mutation API (`createEntry`/`rewriteEntry`…), storage
   interface. App consumes it; SQL views' logic ports into it. This is the
   single most load-bearing step — everything (web, mobile, MCP, E2EE)
   stacks on it.

Then, in shippable phases:

1. **Keys** — passphrase setup, Argon2id, master/recovery/ledger keys,
   wrapped-key tables, device-key silent unlock, recovery kit PDF.
2. **Local replica** — wa-sqlite OPFS replica hydrated from (still
   plaintext) Supabase; all reads/analytics move local. App now feels
   instant; E2EE flip becomes a storage-format change, not a rewrite.
3. **Encrypted oplog** — ops + snapshots tables, HLC, migration: client
   downloads plaintext ledger, re-uploads as encrypted snapshot + starts
   the oplog, plaintext tables dropped per-ledger. Per-ledger opt-in
   during rollout.
4. **Sharing v2** — sealed-box invites, forward key rotation on revoke.
5. **MCP service** — hosted Streamable-HTTP server over `@munshi/core`,
   OAuth consent page with per-ledger key grants, two-phase writes.
6. **Rollups + dashboard** — encrypted derived blobs, unified cross-ledger
   view (Vision §2).

## 10. Explicitly rejected

- **OPAQUE** — passphrase never travels; nothing to protect in transit.
- **Homomorphic/searchable encryption, MPC** — research-grade; aggregates
  leak structure anyway (already rejected in VISION.md).
- **Attested enclaves for MCP/AI** — revisit only if "AI without any local
  install" becomes a requirement.
- **Turnkey frameworks** (Evolu, Jazz, PowerSync-E2EE): Evolu is the
  closest fit but one-maintainer risk + shared-secret sharing (weak
  revocation); Jazz abandons SQL and owns the data model; PowerSync raw
  tables re-sync fully on schema change. Munshi's data is small and its
  brain is already pure TS — the ente+Actual pattern is ~equally much code
  as integrating a framework, with no dependency risk.
- **Per-row random data keys** — overkill at this scale; ledgerKey (+ HKDF
  subkeys per purpose if compartments needed) keeps overhead tiny.
