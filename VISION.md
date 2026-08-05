# Munshi — Vision

Munshi today is a personal double-entry ledger with two screens (Book, Plan).
Munshi tomorrow is a private, AI-assisted bookkeeper for a person's whole
financial life — every ledger they keep, every device they carry, with
end-to-end encryption as the trust foundation.

This document is the long-term product direction. It exists so that every
near-term design decision (UI, schema, API) is checked against where the
product is going, not just what it does today.

---

## 1. AI does the bookkeeping

The user should never have to learn double-entry. They say what happened;
Munshi writes the books.

- **Natural-language entry**: "paid 450 for chai with Faraz, split half" →
  balanced transaction with the right accounts, tag, and reimbursement split.
- **Full operational scope**: the AI can create accounts/cards/loans, post and
  edit entries, record transfers, reconcile balances, set up recurring
  templates and EMIs — everything the UI can do, via conversation.
- **Always confirmable**: AI proposes, the ledger shows a preview diff
  (the postings it will write), user confirms. No silent writes. Trust is
  built by showing the double-entry, not hiding it.
- The existing pure calculation layer (`lib/calc.ts`, `lib/postings.ts`)
  becomes the AI's tool surface — the same brain, one more caller.

## 2. Multiple ledgers, one account

One login, many books: **Personal, Company 1, Company 2, House…**

- Each ledger is a fully isolated set of accounts, transactions, templates,
  members, and settings — its own outlook (name, color/icon, currency
  defaults, fiscal conventions).
- **Ledger switcher** is a first-class navigation element; every screen is
  scoped to the active ledger.
- **Unified dashboard** above all ledgers: net worth across books, upcoming
  dues everywhere, liquidity across everything you own — read-only rollup,
  never mixing entries between books.
- Schema implication: `ledger_id` on every row; membership and roles are
  per-ledger, not per-user-account.

## 3. Shared ledgers

A ledger can be shared — a company with a partner, a household with a spouse.

- **Members with roles** (owner / editor / viewer) per ledger.
- Everyone sees the same books, the same plan, the same reality — including
  rough planning: shared one-offs, shared budgets, shared card cycles.
- **Attribution**: every entry records who wrote it; history shows "Faisal
  added, partner edited".
- Sharing UX must be understandable at a glance: who can see this ledger,
  what they can do, how to revoke.
- (Today's `ledger_members` email table is the seed of this — it becomes
  per-ledger membership with roles.)

## 4. End-to-end encrypted

Financial data is the most sensitive data a person has. The product promise:
**we cannot see your money.**

- Entry contents (descriptions, amounts, account names, notes) are encrypted
  client-side; the server stores ciphertext and only the minimal metadata
  needed to sync.
- **Key ownership is the user's**: passphrase / device keys / recovery kit.
  Shared ledgers use per-ledger keys wrapped for each member.
- The UI must make the guarantee legible — plain language ("your data is
  encrypted with keys only you hold"), key status, recovery flow, and honest
  boundaries (what metadata remains visible).
- **Design tension to resolve deliberately**: E2EE vs. server-side AI and
  cross-device compute. Direction: computation happens client-side (or in
  user-keyed enclaves); AI calls send only what the user's key decrypts
  locally, never raw server data. Views like `account_balances` move from
  Postgres into the client's calculation layer — which is why the pure
  TypeScript brain matters: it must run anywhere.

### E2EE architecture (decided)

Ledger data is small (a heavy user ≈ a few MB/year encrypted), so the
architecture is **local-first replica + encrypted oplog sync**, the pattern
proven by Actual Budget, Signal, and ente:

- **Client**: full plaintext replica in a local DB (SQLite on mobile,
  wa-sqlite/OPFS on web). All math runs locally — `calc.ts` is already
  shaped for this; the SQL views migrate into it.
- **Server**: append-only **encrypted operation log** per ledger. Each op is
  one mutation, encrypted with the ledger key and sequenced by the server;
  clients pull and apply. Shared ledgers = ledger key wrapped for each
  member's public key.
- **Bootstrap**: periodic encrypted snapshot checkpoints; a new device loads
  the latest snapshot + tail ops instead of replaying history.
- **Fast dashboards**: clients compute monthly rollups (category totals, net
  worth points), encrypt, and upload as derived blobs; the unified dashboard
  reads ~dozens of small blobs, never raw history.
- **Server's plaintext-free jobs**: sync ordering and fanout, auth,
  per-ledger membership and key distribution, push notification triggers
  (content decrypts on device), ciphertext backups, billing, rate limiting.
  Only deliberate structural metadata stays clear: ledger id, op sequence,
  timestamps, device ids — never amounts, names, or descriptions. If
  server-side equality lookup is ever needed, blind indexes (HMAC of
  normalized values) — sparingly.
- **Explicitly rejected**: homomorphic/searchable encryption and MPC —
  research-grade, slow, and financial aggregates leak structure regardless.

### AI within the E2EE boundary — three tiers

1. **On-device** (fully E2EE): SMS/notification parsing, categorization —
   small local models.
2. **Consented slice** (default for chat/insights): the client decrypts the
   relevant scope (e.g., this month), sends it to the LLM over TLS under
   zero-retention terms, with explicit per-conversation consent — "Share
   August data with AI?". Not E2EE for that slice; the UI says so plainly.
3. **Attested enclave** (later, if demanded): server-side inference inside
   hardware-attested isolation (Nitro-style); the ledger key is released
   only after attestation. Larger context without disclosure, at the cost of
   trusting the attestation chain.

The trust message stays honest: *encrypted with your keys; AI sees only what
you explicitly share, only when you ask.*

## 5. Mobile apps that capture entries automatically

Android and iOS apps whose core job is **capture at the moment of spend**.

- Read bank/card **SMS and payment notifications** on-device, parse amount,
  merchant, account — draft the entry automatically.
- The user is asked only for what machines can't know: **narration** ("what
  was this for?"), a tag, a split. One tap to confirm.
- Parsing happens on-device (privacy + E2EE compliance); nothing leaves the
  phone unencrypted.
- Offline-first: entries queue locally, sync when connected; conflicts
  resolve by ledger rules, not last-write-wins on money.
- The web app remains the desk — review, plan, reconcile; the phone is the
  point of capture.

## 6. Category analytics

Spending must become understandable, not just recorded.

- Categories (Food, Grocery, Transport…) as a proper hierarchy over expense
  accounts and tags.
- **Projection dashboard**: monthly trend per category, average vs. this
  month, projected month-end per category at current pace, budget vs. actual.
- Answers the questions people actually ask: "how much do I spend on food?",
  "is this month unusual?", "what's my burn rate?"
- All computable from postings already captured — analytics is a read layer,
  no new write model.

## 7. AI insights

Beyond bookkeeping — the munshi's actual job was advice.

- **Understand**: "you spent 40% more on eating out this month, driven by
  8 Zomato orders in week 2."
- **Reduce debt**: EMI and card-cycle awareness → payoff-ordering advice,
  "pay card X before Y", interest-cost visibility, prepayment what-ifs.
- **Save**: detect avoidable/deferrable patterns (the tags already exist),
  suggest envelope amounts, flag when projected savings diverges from plan.
- Insights are grounded in the user's own ledger math (same `calc.ts` brain),
  presented with the numbers that justify them — explainable, never oracular.
- Runs within the E2EE boundary (see §4).

---

## What this means for near-term design

Every UI/UX decision made now should not fight this future:

1. **One detail surface per entity** (account/card/person/loan) — becomes the
   anchor for AI actions, mobile deep-links, and analytics drill-downs.
2. **Pure, portable calculation layer** — keep all math in dependency-free
   TypeScript so it can run on web, mobile, and inside the E2EE boundary.
   Move logic out of SQL views over time, not into them.
3. **Every mutation goes through one API** (`createEntry`/`rewriteEntry`
   style) — the same path serves UI, AI, and mobile capture; preview-diff
   before write becomes possible everywhere.
4. **Ledger-scoped data model** — new tables and features assume
   `ledger_id` + per-ledger membership from day one, even while the UI still
   shows a single ledger.
5. **Labeled, self-explanatory forms and numbers** — if a human can't tell
   what a field or a headline number means, an AI explaining it on the
   user's behalf is a crutch, not a fix. Clarity first, AI on top.
