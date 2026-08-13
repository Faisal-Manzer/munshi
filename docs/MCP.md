# Munshi MCP — design

Munshi as a tool surface: an MCP server that lets an AI client (Claude, or any
MCP host) do everything the web UI can do, over OAuth, against one selected
ledger, with a preview-and-approve step in front of every write.

This is VISION §1 ("full operational scope… AI proposes, the ledger shows a
preview diff, user confirms") implemented outside the app.

---

## 0. Decisions

| Question | Decision |
|---|---|
| Transport | Remote HTTP MCP at `munshi.manzer.in/api/mcp`, same Next.js deploy |
| Auth | OAuth 2.1 authorization server built in-app over Supabase Auth |
| Key delivery | Passphrase entered in the **browser** during OAuth consent; only the unwrapped `masterKey`, sealed to the server's public key, leaves the device |
| Session state | **None.** Sealed key rides in the access token; proposals are self-contained sealed blobs |
| Ledger selection | First tool call fails with a ledger list; `select_ledger` pins it into the token |
| Approval | Two-phase: every write returns a preview + `proposal_id`; `commit_proposal` writes |
| Approval unit | One proposal per *logical operation* (a loan and its 12 EMIs = one approval) |
| Preview content | Postings + before→after balances + plain-English explanation |
| Code home | `packages/mcp` (pure) + `src/app/api/mcp`, `src/app/api/oauth` (routes) |

### The trade being made, stated plainly

E2EE today means the server never holds a key. This design breaks that: for
the duration of an MCP request, `/api/mcp` holds the unwrapped `masterKey` in
memory and can read every amount, description and account name.

What the design still preserves:

- The **passphrase** never leaves the browser. Argon2id runs client-side; the
  server never sees it and cannot brute-force stored ciphertext later.
- Nothing key-shaped is **persisted** — no Redis, no table, no disk. The key
  exists only inside a single request's heap.
- Revocation is real: rotating the server's X25519 keypair invalidates every
  outstanding sealed token at once.

What it does not preserve:

- A compromised deploy, a malicious dependency, or a heap dump during a live
  request exposes plaintext for that user's ledger.
- The access token held by the MCP client is now key material. Anyone holding
  it can read the book until it expires.

`docs/E2EE.md` and any user-facing security copy must be updated to say this.
Connecting MCP is a per-user, opt-in downgrade of the guarantee — the consent
screen has to say so in those words.

---

## 1. Auth flow

MCP requires OAuth 2.1 + PKCE, protected-resource metadata (RFC 9728) and
dynamic client registration (RFC 7591). Supabase Auth provides none of the
last two, so the app is its own authorization server and uses Supabase only to
identify the human.

```
/.well-known/oauth-protected-resource   → points at the AS
/.well-known/oauth-authorization-server → endpoints, PKCE S256, scopes
POST /api/oauth/register                → DCR, returns client_id
GET  /api/oauth/authorize               → consent + ledger pick + unlock
POST /api/oauth/token                   → PKCE exchange, refresh
POST /api/oauth/revoke
```

`/api/oauth/authorize` is the interesting one. It is a real page in the app,
so it already has the Supabase session:

1. Sign in with Supabase if not already (existing `/login`).
2. **Consent** — which client is asking, what it can do, and the plain-language
   warning that connecting lets the server read this ledger.
3. **Ledger pick** — radio list of the user's ledgers.
4. **Unlock** — passphrase field. In the browser: `deriveKek` → unwrap
   `encryptedMasterKey` → unwrap the ledger key. Only the ledger key is
   needed, so seal *that*, not the master key — a token scoped to one book
   cannot open another.
5. Seal to the server: `seal(ledgerKey, SERVER_PUBLIC_KEY)` using the existing
   X25519 helpers in `@munshi/crypto`.
6. Redirect with the auth code; `/api/oauth/token` returns:

```jsonc
{
  "access_token": "<jwt>",   // { sub, ledger_id, sealed_ledger_key, kid, exp }
  "refresh_token": "…",      // re-seals on refresh; cannot outlive the unlock grant
  "expires_in": 3600
}
```

Every `/api/mcp` request: verify JWT → `openSealed(sealed_ledger_key,
SERVER_PRIVATE_KEY)` → key in a local → do the work → `wipe()` in a `finally`.

`SERVER_PRIVATE_KEY` is a Vercel env secret; `kid` in the token lets an old key
be retired without breaking live sessions during a rotation window.

### Ledger selection

Chosen at consent time, baked into the token. Switching mid-session:

```
any_tool()      → error NO_LEDGER: "Pick a ledger" + list   (only when unscoped)
select_ledger() → returns an authorize URL; user re-unlocks the target book
```

A ledger switch requires a browser round-trip by construction — the server
cannot unwrap another ledger's key from the token it holds. That is the
design working, not a limitation to route around.

---

## 2. The two-phase write

Every mutating tool is `propose_*`. It never touches the database.

```
propose_x(args)
  → build op(s) from @munshi/core builders
  → assertBalanced()
  → render preview against current state
  → return { preview, proposal_id, expires_at }

commit_proposal(proposal_id)
  → open the sealed blob
  → check expiry (15 min)
  → check the precondition hash — refuse if the ledger moved underneath
  → apply through LedgerStore, atomically
  → return what was written
```

`proposal_id` is not an id. It is the proposal:

```jsonc
// base64( seal( {...}, SERVER_PUBLIC_KEY ) )
{
  "ops": [ /* McpOp[] — the exact writes, nothing re-derived at commit */ ],
  "ledger_id": "…",
  "user_id": "…",
  "pre": "sha256 of the balances/rows the preview was computed from",
  "exp": 1755100000
}
```

Consequences worth being explicit about:

- **No storage** — matches the stateless decision, survives cold starts.
- **Unforgeable** — sealed to the server key, so the model cannot hand-craft a
  proposal that writes something the user never saw previewed.
- **What you approved is what gets written.** The commit does not re-run the
  builder; it replays the frozen ops.
- **Stale proposals are refused.** If a balance the preview depended on moved
  (another device, the web app), `pre` mismatches and commit returns
  `STALE_PROPOSAL` with a fresh preview to re-approve.
- The blob can get large for a 60-month EMI schedule. Cap: if serialized ops
  exceed ~6 KB, store the *schedule parameters* rather than every generated
  row and regenerate deterministically at commit, with `pre` covering the
  parameters.

### What core needs

`LedgerOp` today is only `entry.create | entry.rewrite`. Account creation,
template creation, patches and deletes go through separate `LedgerStore`
methods, so they cannot be frozen into a proposal or committed atomically
with an entry.

**Work item:** widen the union in `packages/core/src/store.ts` to an `McpOp`
superset —

```
entry.create · entry.rewrite · entry.patch · entry.delete
account.create · account.update
template.create · template.update
```

— and give `LedgerStore` an `applyAll(ops: McpOp[]): Promise<Result[]>` that
runs them in one transaction. The web UI keeps its current methods (they can
become thin wrappers). Without this, "create the loan account *and* its EMI
template" is two half-approvable writes.

---

## 3. Tool surface

Reads never prompt. Writes are always `propose_*` + `commit_proposal`.

**Session**
`whoami` · `list_ledgers` · `select_ledger` · `ledger_settings`

**Read**
`list_accounts` (tree, balances, liquid flags) · `account_detail` ·
`list_entries` (filter: date range, account, tag, status, text/amount via
`search.ts`) · `entry_detail` · `balances` · `liquid_now` ·
`card_cycles` · `month_plan` · `month_actuals` · `liquid_outlook` ·
`list_templates` · `emi_status` · `list_tags` · `list_members`

**Write — entries**
`propose_entry` · `propose_entry_edit` · `propose_entry_delete` ·
`propose_transfer` · `propose_split_entry` (reimbursement leg) ·
`propose_mark_done` (pending → done) · `propose_bulk_import`

**Write — accounts**
`propose_account` (bank, cash, envelope, investment, credit card, card child,
loan, person/receivable) · `propose_account_edit` · `propose_archive_account` ·
`propose_opening_balance`

**Write — recurring / EMI**
`propose_template` · `propose_template_edit` · `propose_emi` ·
`propose_emi_close` · `propose_budget` (`is_budget` internal transfer)

**Write — operations**
`propose_reconcile` · `propose_card_payment` · `propose_loan` ·
`propose_loan_repayment` · `propose_settle_person`

**Write — sharing**
`propose_invite_member` · `propose_role_change` · `propose_remove_member`

Sharing writes touch ledger key wrapping and stay **read-mostly in v1**:
inviting a member requires sealing the ledger key to their public key, which
the server can do only because it currently holds the key — worth doing
deliberately, not as a side effect of a chat message. `propose_invite_member`
ships behind an explicit confirmation that names the invitee's public key
fingerprint.

---

## 4. The four flows, end to end

### 4.1 Create an account

Accounts are the one write with no postings of its own — unless an opening
balance is given, which conjures a balanced equity entry
(`postEquityAdjustment` against the `opening_balance` equity account).

```
propose_account(
  type: "credit_card", name: "Amazon Pay ICICI",
  statement_day: 18, due_day: 5, credit_limit: 200000
)
```

```
NEW ACCOUNT — Amazon Pay ICICI
  kind      liability / credit_card
  statement 18th   due 5th   limit ₹2,00,000
  liquid    no

No postings. Opening balance not set — the card starts at ₹0 owed.

proposal p_a41c · expires 15:22
```

With an opening balance the preview gains the entry:

```
  Dr  Opening balances       48,320
  Cr  Amazon Pay ICICI       48,320

  Amazon Pay ICICI    ₹0 → ₹48,320 owed

  The card already carries ₹48,320. That lands as equity, not as a
  spend, so this month's expense totals stay honest.
```

Card children (`parent_id` → parent card) and envelopes (under a bank) work
the same; the preview names the parent and shows that the parent's subtree
balance is what changes.

### 4.2 Loan account

Two directions, two shapes — the tool asks which:

- **You lent** → asset, `subtype: receivable`, the person's account.
- **You borrowed** → liability, `subtype: loan`.

A loan is not one thing in the schema. It is an account plus (optionally) a
recurring template that carries the repayment. One proposal, both writes.

```
propose_loan(
  direction: "borrowed", name: "Bike loan — HDFC",
  principal: 100000, rate_pa: 10, months: 12,
  disburse_to: "ICICI main", first_due: "2026-09-05"
)
```

```
LOAN — Bike loan — HDFC   ₹1,00,000 @ 10% p.a. × 12

Account
  Bike loan — HDFC        liability / loan

Disbursal (1 Sep 2026)
  Dr  ICICI main          1,00,000
  Cr  Bike loan — HDFC    1,00,000

  ICICI main         2,40,000 → 3,40,000
  Bike loan — HDFC           0 → 1,00,000 owed

Repayment template (autodebit_bank, 5th, 12 installments)
  from  ICICI main
  to    Bike loan — HDFC
  each  ₹8,792   ·   starts 05 Sep 2026   ·   ends 05 Aug 2027

  Schedule
    #   date        emi      interest   principal   outstanding
    1   05 Sep 26   8,792       833       7,959       92,041
    2   05 Oct 26   8,792       767       8,025       84,016
    …
   12   05 Aug 27   8,792        73       8,719            0
                   ─────────────────────
                   1,05,504     5,504    1,00,000

You borrow ₹1L today, it lands in ICICI main, and ₹8,792 leaves that
account on the 5th of each month for a year. Total interest ₹5,504.

proposal p_7d10 · expires 15:31
```

The plan screen reads this through `emiInfo`/`emiActive` — installment 3 of 12
in November, gone from the plan after August 2027, no manual cleanup.

Note the honest limitation: the template carries a **fixed EMI amount**, so
the interest/principal split in the schedule is informational, not posted
separately. Each month's posting is one ₹8,792 leg against the loan account.
If you want interest booked as an expense, that is a second template
(`propose_template` with the interest leg) and the preview says so rather than
pretending the split is recorded.

`propose_loan_repayment` handles off-schedule and prepayments: one entry, plus
an offer to shorten `total_installments` — shown as a diff on the template.

### 4.3 Credit card EMIs

A card EMI is a purchase converted into installments billed to the card. Three
things happen and the preview shows all of them:

```
propose_emi(
  card: "Amazon Pay ICICI", description: "MacBook",
  amount: 120000, months: 6, first_billing: "2026-09-18",
  category: "Electronics"
)
```

```
CARD EMI — MacBook   ₹1,20,000 → 6 × ₹20,000 on Amazon Pay ICICI

Template (autodebit_cc, day 18, 6 installments)
  from  Amazon Pay ICICI      to  Electronics
  each  ₹20,000  ·  Sep 2026 → Feb 2027

Each month posts
  Dr  Electronics            20,000
  Cr  Amazon Pay ICICI       20,000

Effect on the card
  cycle          statement 18th, due 5th
  billed now     ₹48,320  →  ₹68,320 from the Sep statement
  limit          ₹2,00,000     available after Sep bill  ₹1,31,680

₹20,000 is added to this card's bill on the 18th for six months.
It is not a new spend each month — the ₹1,20,000 purchase is already
made; this spreads when the card asks you to pay for it.

Balance today is unchanged. The first posting is 18 Sep 2026.

proposal p_c93b · expires 15:40
```

Points the preview must be honest about:

- If the purchase was **already logged** as a single ₹1,20,000 spend, creating
  an EMI on top double-counts. `propose_emi` searches the card's recent
  entries for a matching amount and, if found, includes the reversal in the
  same proposal — or refuses with `LIKELY_DUPLICATE` and shows the candidate.
- Card cycles come from `computeCardCycles`; the preview quotes
  `billed_paise` / `spends_since_paise` for the real cutoff, not a guess.
- Interest and processing fees are separate entries. The tool asks, and when
  given, they appear as their own postings in the same proposal.

`propose_card_payment` is the counterpart: preview shows `cardDueNow` versus
what is being paid, and what is left unbilled (`cardUnbilled`).

### 4.4 Reconcile

Reconciliation is an event, not a stored comparison (see
`src/components/reconcile-modal.tsx`). The MCP flow mirrors it exactly.

```
propose_reconcile(account: "ICICI main", real_balance: 238400)
```

```
RECONCILE — ICICI main

  book (incl. envelopes)   ₹2,40,000
  you say                  ₹2,38,400
  gap                        −₹1,600

Adjustment entry (13 Aug 2026)
  Dr  Adjustments             1,600
  Cr  ICICI main              1,600

  ICICI main    2,40,000 → 2,38,400

Also records: reported_balance = ₹2,38,400, reported_at = today.

The book is ₹1,600 higher than the bank, so ₹1,600 was spent and never
logged. That goes to Adjustments. Last reconciled: 28 Jul 2026.

proposal p_2e88 · expires 15:47
```

Behaviour carried over from the UI, which the tool must not quietly change:

- Banks and cards reconcile **including their children** (`subtreeBalance`) —
  the bank app shows one pot.
- Liabilities are entered as positive-owed; `displayBalance` handles the sign.
- A person (`receivable`) needs a direction — `owes_me: true|false` — because
  the debt can run either way. The tool asks rather than inferring from sign.
- `Adjustments` is found by name or created (`ensureAccount(…, "name")`).
- `apply_adjustment: false` records the reported balance without posting the
  gap. The preview then shows no postings and says the gap will stay.
- Zero gap: no entry, only the reported stamp. The preview says "matches".

---

## 5. Errors the model must handle

| Code | Meaning |
|---|---|
| `NO_LEDGER` | Token unscoped; call `select_ledger` |
| `LOCKED` | No sealed key in the token — re-authorize |
| `STALE_PROPOSAL` | Ledger moved since preview; a fresh preview is attached |
| `EXPIRED_PROPOSAL` | Past 15 min; re-propose |
| `ALREADY_COMMITTED` | Replay guard — proposal already applied |
| `UNBALANCED` | `assertBalanced` rejected the ops (a bug, surfaced not swallowed) |
| `LIKELY_DUPLICATE` | A matching entry already exists; candidates attached |
| `FORBIDDEN` | Role is `viewer` |

Replay: committed proposals are the one thing that *must* be remembered.
A `mcp_committed` table storing `(user_id, proposal_hash, txn_id, committed_at)`
holds hashes only — no plaintext, no key — and doubles as the MCP audit log.

---

## 6. Build order

1. `McpOp` union + `applyAll` in `packages/core` (blocks everything else).
2. Move `src/lib/e2ee/codec.ts` into `packages/crypto` (or a new
   `packages/store`) so a server-side driver can seal rows.
3. `ServerLedgerStore` — implements `LedgerStore` against Supabase with the
   user's JWT and the ledger key.
4. OAuth AS routes + consent/unlock page.
5. `packages/mcp`: session, proposal seal/open, preview renderer.
6. Read tools (proves auth + decryption end to end, zero write risk).
7. Entry writes — the full propose/commit loop on the simplest op.
8. Accounts, loans, card EMIs, reconcile, templates.
9. Members/sharing, behind the extra confirmation.
10. Security-page copy update. Not optional — it is currently wrong the
    moment step 4 ships.
