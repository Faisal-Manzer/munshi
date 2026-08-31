# Munshi — feature reference

Munshi is a personal double-entry finance ledger for INR. It replaces a
money-management spreadsheet with two screens — **Book** (what happened and is
happening this month) and **Plan** (what next month and beyond look like) —
backed by strict double-entry bookkeeping in Postgres (Supabase).

This document is the complete feature reference: every behaviour, every
formula, every screen element, and the data model underneath.

---

## Table of contents

1. [Core concepts](#1-core-concepts)
2. [Data model](#2-data-model)
3. [Money handling](#3-money-handling)
4. [Accounts](#4-accounts)
5. [Transactions & postings](#5-transactions--postings)
6. [Recurring templates](#6-recurring-templates)
7. [EMIs (installment plans)](#7-emis-installment-plans)
8. [Credit cards & statement cycles](#8-credit-cards--statement-cycles)
9. [The Book page](#9-the-book-page)
10. [The Plan page](#10-the-plan-page)
11. [People, splits & reimbursements](#11-people-splits--reimbursements)
12. [Envelopes & budgets](#12-envelopes--budgets)
13. [Liquidity](#13-liquidity)
14. [Reconciliation](#14-reconciliation)
15. [Multiple & shared ledgers](#15-multiple--shared-ledgers)
16. [Authentication](#16-authentication)
17. [UI component system](#17-ui-component-system)
18. [Formatting & display rules](#18-formatting--display-rules)
19. [Architecture & deployment](#19-architecture--deployment)
20. [Database migrations](#20-database-migrations)
21. [Testing](#21-testing)

---

## 1. Core concepts

- **Double-entry**: every entry is a balanced transaction made of postings.
  Debits are positive, credits are negative; a deferred database trigger
  rejects any transaction whose postings don't sum to zero.
- **Two screens only**:
  - **Book** — the current month's ledger plus history. Real entries,
    projected recurring items, expected repayments, account balances.
  - **Plan** — future months only (next month onward). Answers "what does
    next month look like?" before it starts.
- **One brain for the math**: the Book's headline numbers and the Plan's
  per-month numbers use the same classification rules (income vs. committed
  vs. internal vs. card-charged), so the two screens never disagree about
  what a template means.
- **Nothing hardcoded**: no account is special by name. Liquidity, card
  behaviour, budgets, EMI windows — all data-driven via flags and fields on
  accounts and templates.

## 2. Data model

Five tables, two views, all under Supabase row-level security.

### `accounts`

The chart of accounts. One row per bank, card, envelope, person, loan,
income source, expense category, investment.

| Column | Meaning |
|---|---|
| `kind` | `asset` \| `liability` \| `income` \| `expense` \| `equity` |
| `subtype` | `bank`, `envelope`, `cash`, `investment`, `receivable` (a person), `credit_card`, `loan`, `salary`, `other_income`, `general_expense`, `opening_balance` |
| `parent_id` | tree structure: envelopes under a bank, sub-cards under a parent card |
| `statement_day`, `due_day` | credit-card cycle metadata (1–31) |
| `credit_limit_paise` | optional card limit |
| `person_name` | set for `receivable` accounts |
| `reported_balance_paise`, `reported_at` | last reconciled real-world balance (signed like the ledger: assets +, liabilities −) |
| `is_liquid` | spendable-cash flag — see [Liquidity](#13-liquidity) |
| `archived` | hidden from lists, kept in history |

### `transactions`

| Column | Meaning |
|---|---|
| `date` | entry date (`yyyy-mm-dd`) |
| `description` | the title |
| `status` | `pending` (planned, not yet paid) or `done` |
| `tag` | free text (defaults offered: `avoidable`, `partially avoidable`, `deferrable`) |
| `recurring_template_id` | set when the entry was posted from a template |
| `reimburse_account_id`, `reimburse_amount_paise` | split: person expected to pay part back |
| `notes` | free text |

### `postings`

The legs. `amount_paise` is a nonzero bigint, debit `+` / credit `−`. A
deferred constraint trigger (`postings_balanced`) checks at commit time that
each transaction's postings sum to zero — so multi-statement rewrites are
possible inside one batch, but nothing unbalanced can ever be committed.

### `recurring_templates`

Monthly items — see [Recurring templates](#6-recurring-templates).

### `ledgers` and `ledger_memberships`

One login, many books. Every data row carries a `ledger_id`; membership and
roles are per ledger — see [Multiple & shared ledgers](#15-multiple--shared-ledgers).

### Views

- **`account_balances`** — per account: `balance_paise` (all postings),
  `settled_paise` (done only), `pending_paise` (pending only).
- **`card_cycle_balances`** — per credit-card account: the most recent
  statement cutoff date, `billed_paise` (net balance up to the cutoff),
  `payments_since_paise` (credits after the cutoff — bill payments), and
  `spends_since_paise` (debits after the cutoff — unbilled swipes). Only
  `done` transactions count. Sub-cards inherit the parent's statement day if
  they have none.

## 3. Money handling

- Amounts are stored as **integer paise** (`bigint`; ₹1 = 100 paise). No
  floats anywhere in storage or arithmetic.
- Display always shows **exactly two decimals** with Indian digit grouping:
  `₹1,23,456.00` (`Intl.NumberFormat("en-IN")`).
- `parseRupees` accepts user input with `₹`, commas, and spaces
  (`"17,099"`, `"17099.50"`) and rounds to paise.
- Zero is normalised so it never renders as `-₹0.00`.
- The `Amount` component renders green (`text-ledger`) for positive and red
  (`text-debit`) for negative when `signed`, with a leading `+` on positive
  signed amounts.

## 4. Accounts

### Types you can create

From the account modal (scoped per sidebar block):

| Option | kind/subtype | Notes |
|---|---|---|
| Bank account | asset/bank | |
| Envelope | asset/envelope | requires a parent bank |
| Cash | asset/cash | |
| Investment | asset/investment | |
| Credit card | liability/credit_card | statement day, due day, optional limit |
| Sub-card | liability/credit_card | requires a parent card; bills to it |
| Loan (you owe) | liability/loan | |
| Person (owes you) | asset/receivable | |
| Salary / income source | income/salary | |
| Expense category | expense/general_expense | |

### Opening balances

When creating a bank, cash, loan, card, person, or investment account you can
enter a current balance/outstanding. Munshi books it double-entry against an
auto-created equity account (“Opening balances”, subtype `opening_balance`) —
sign flipped for liabilities — so the books stay balanced from day one.

### Liquid checkbox

Any **asset** account shows a "Liquid" checkbox. Default for new accounts:
banks, cash, and envelopes are liquid; everything else is not. It can be
flipped freely (a locked-FD bank → not liquid; a liquid-fund investment →
liquid).

### Editing & archiving

Every account name in the sidebar is clickable and opens the edit modal
(name, card days, limit, liquid flag). **Archive** (with confirm) hides the
account from all lists but keeps every historical posting.

## 5. Transactions & postings

### The entry model

Every row you type is one balanced transaction: **From** is credited (money
or credit leaves), **To** is debited.

| You did | From | To |
|---|---|---|
| Groceries on card | credit card | expense category |
| Paid card bill | bank | credit card |
| Moved money between banks | bank A | bank B |
| Set money aside | bank | its envelope |
| Salary landed | salary | bank |
| Someone's EMI hit your card | credit card | that person (receivable) |
| Dinner, friend owes half | card/bank + split | expense |
| Friend paid you back | friend (receivable) | bank |
| Lump-sum loan prepayment | bank | loan |

`buildPostings` produces two legs, or three when a split is set: `from`
−amount, `to` +(amount − their share), person +(their share).

### Pending vs. done

`pending` = planned, money hasn't moved. Pending entries appear in the Book
(tinted) with a **paid** action that marks them done and re-dates them to
today. Done entries can be reverted to pending (the ↺ icon). Pending
transactions dated in future months are exactly what the Plan page calls
"one-offs" — one shared mechanism, zero extra tables.

### Complex (multi-leg) entries

An entry with more than one credited leg, or any leg touching an equity
account, renders **read-only** as a summary row with an expandable leg list
(sorted, signed amounts) — so opening balances and hand-crafted multi-leg
entries can't be mangled by the inline editor.

### Editing

Everything is editable inline in the table — see
[Book: the ledger table](#the-ledger-table). Edits that change accounts or
amount rewrite the postings atomically: the transaction row is updated, all
postings deleted, and new balanced postings inserted (the deferred trigger
guarantees no intermediate unbalanced state survives a failed write).
Deletion asks for confirmation and cascades to postings.

## 6. Recurring templates

A template is a monthly item: rent, salary, an EMI, a subscription, a budget
transfer.

Fields:

- **name**, **amount**, **day of month** (1–31; days 29–31 clamp to
  month-end in short months)
- **kind** — payment mechanics, for your own reference: auto-debit from
  bank, auto-debit on card, manual payment, pay-before-due
- **from / to accounts** — same credit/debit semantics as entries
- **someone repays part** — expected reimbursement: person, their share, and
  the day you expect it ([details](#11-people-splits--reimbursements))
- **total installments + first installment date** — makes it an EMI
  ([details](#7-emis-installment-plans))
- **is_budget** — see [Budgets](#12-envelopes--budgets)
- **Stop** deactivates the template (past posted entries stay)

### Classification (shared by Book and Plan)

- **Income template**: `from.kind === "income"` — counts into "coming in".
- **Internal template**: asset → asset (and not to a person) and not a
  budget — a transfer, excluded from committed spend.
- **Card-charged template**: `from` is a credit card — costs cash later via
  the card bill, so it is *excluded* from cash committed and *included* in
  the card-cycle projections.
- Everything else is **cash-committed spend**.

### Posting

In the Book, an unposted template shows as a *virtual row* with a **post**
button. Posting opens a modal prefilled with the planned amount (editable —
utility bills vary). The created entry is `done`, dated today, linked via
`recurring_template_id`; an expected reimbursement is scaled proportionally
if you changed the amount. Once posted, the virtual row disappears for that
month (the real entry carries a ✓ marker).

## 7. EMIs (installment plans)

Any template with **total installments** and a **first-installment date**
becomes an EMI with a window:

```
idx(month)  = monthIndex(month) − monthIndex(start_date) + 1   // 1-based
active      = 1 ≤ idx ≤ total_installments
end date    = start_date + (total − 1) months (day clamped to month length)
```

Effects everywhere:

- **Book**: virtual rows show `EMI 3/12 · ends Nov 2026`.
- **Plan**: the Every-month registry shows the same progress; templates
  outside their window render dimmed with `starts <month> — not counted` or
  `ended <month> — not counted`.
- **Math**: an inactive EMI is excluded from that month's income/committed/
  expected-back totals *and* from card-cycle projections — so planning
  Jan 2027 automatically drops EMIs that end in Dec 2026.
- The template form derives and stores `end_date` from start + count.
- A template with an installment count but *no* start date falls back to
  counting posted entries (`installment 2/12`) and prompts you to set the
  first-installment date for real progress.

## 8. Credit cards & statement cycles

Cards carry a **statement day** (bill cuts) and a **due day** (bill must be
paid). **Sub-cards** (e.g. a family member's add-on card) are separate
accounts with `parent_id` set; all math folds a parent card's subtree
together.

### Current cycle (Book, via `card_cycle_balances`)

For each parent card (plus its sub-cards):

- **due now** = max(0, −billed − payments since cutoff) — what the last
  statement still needs.
- **unbilled** = −spends since cutoff — swipes that will be on the next bill.
- **owed** = due + unbilled.

The Book header shows **card due** (Σ due now) and **card owed** (Σ owed).
The Cards sidebar block shows per-card owed, `due ₹X by the 15th`,
`₹Y unbilled — bills on the 27th`, which sub-cards are included, and any
reconciliation gap.

### Future cycles (Plan)

For a plan month *m*, Munshi finds, per card, the statement whose **due date
lands in m** (searching statements within ±2 months of the horizon, so any
plan distance works):

```
statement st  = statement_day in some month k
due           = due_day after st (same month if due_day > statement_day,
                else next month)
window        = (previous statement, st]     — the swipes that bill on st
```

The projected bill for that window =

- **already swiped** — real unbilled spends, if the window is currently
  open (`spends_since` of the live cycle);
- **recurring to come** — card-charged templates whose occurrence falls in
  the window after today, EMI-window-checked at the occurrence month;
- **planned one-offs** — pending transactions paid from the card subtree
  dated inside the window.

If the window hasn't even opened yet, the number is marked
*estimate — recurring card charges only, cycle hasn't started*.

This is the **carry-over principle**: a swipe made during month *m* that
bills later belongs to the month after — it shows up when you plan that
month, never double-counted.

## 9. The Book page

Route `/`. One unified month ledger plus a sidebar of balances.

### Month navigation

`←  September 2026  →` — fixed-width title so arrows never shift. Backward
navigation stops at the **earliest logged month** (no empty pre-history);
forward stops at the **current month** (the future belongs to Plan). Past
months show only what was actually logged — no projected or receive rows,
with an explanatory empty-state if nothing was logged.

### Headline numbers

Right of the title, for the viewed month:

| Number | Formula |
|---|---|
| **in** | Σ income templates active this month |
| **cash committed** | Σ non-income, non-internal templates *not* charged to a card |
| **card due** | Σ current statement dues across parent cards |
| **card owed** | card due + all unbilled swipes |
| **coming back** | Σ expected reimbursements on templates |
| **left ⓘ** | in − cash committed − card owed + coming back |
| **avoidable** | Σ this month's entries whose tag contains "avoid" (shown only when > 0) |

**left** is clickable — a modal breaks the formula down line by line and
explains the philosophy: this is *planning money* (what remains of the
month's income after every known commitment, if you cleared all card debt),
not a bank balance; ad-hoc spends show up in account balances instead. This
is the **true cash-flow view**: card owed counts in full rather than being
smoothed over future bills.

### The ledger table

Identical column layout everywhere (Book and Plan):
`Date | Title | Account | Amount | Tag | Note | actions`.

Row types, in order:

1. **Quick-add row** (always first, tinted green):
   - custom **date picker** (defaults today), **title input** with
     suggestions ([see below](#17-ui-component-system)) that prefill
     accounts and tag from how that title was last booked,
     **from → to** account selects (to defaults to the first expense
     category; `＋ New category…` inline-creates one), amount, tag (with
     known-tags datalist), note.
   - **planned/done toggle**: entries dated in the future default to
     *planned* (pending); the toggle overrides either way. Button reads
     `Plan ↵` or `Add ↵`; Enter anywhere in the row saves.
2. **Opening entries** — collapsed into a single summary row on top
   (`Opening entries · 4 · show`); expanding lists each equity-touching
   entry read-only with its legs.
3. **Virtual rows** — unposted templates, placed at their day-of-month
   (clamped to month length). Grey until their date passes, then tinted red
   with an `overdue` badge. Show EMI progress, from ⇄/→ to accounts, a
   pencil (edit template) and **post**.
4. **Receive rows** — expected reimbursements from templates, placed at the
   expected repay day. `Rahul repays Business EMI` with a **receive** button;
   automatically marked `✓ received` once that person's credits this month
   reach the expected amount; red `overdue` when the day passes unreceived.
5. **Real entries** — fully inline-editable:
   - date (custom picker), title, from/to (grouped account selects), amount
     (shows signed/formatted, becomes a raw number on focus), tag, note —
     each saves on change/blur.
   - amount colour: green income, red spend, grey internal transfer; the
     account cell shows `→` for spends and `⇄` for internal moves.
   - **actions**: ✓ marker (posted from a template) · **paid** (pending →
     done, re-dated today) / ↺ (done → pending) · 👥 **split** ·
     ⇄ **cover** (only when the paying account is liquid) · × delete.

### Split modal

Attach a person to an entry: pick who and their share (must be less than the
total). Their share moves off your expense and onto what they owe you; "No
split" removes it. [Details](#11-people-splits--reimbursements).

### Cover modal

For "wrong pocket paid" moments: the entry stays as-is, and Munshi records a
second transfer `Cover: <title>` pulling the amount from the account that was
really meant to pay into the liquid account that stood in. Source list =
every other liquid account.

### Receive modal

Records `person → bank` for any repayment: amount prefilled from what's
expected (or the full balance from the People block), destination limited to
liquid accounts.

### Sidebar

Five blocks, each with a `+` scoped to the right account types:

- **Accounts** — banks and cash with subtree balances (envelope money
  included); per bank with envelopes, a faint `free ₹X` line (own balance
  excluding envelopes) and each envelope indented with its balance; a
  reconcile (⚖) button and a red `±₹X vs bank` gap when reconciled; a gear
  opens **Categories & income** (rare CRUD for expense categories and income
  sources, kept out of the way).
- **Cards** — per parent card: owed, due-by line, unbilled line, included
  sub-cards, reconciliation gap (`unlogged on card` / `over-logged`).
- **People** — everyone with a nonzero balance (`owes you` green / `you
  owe` red), a hand-coins button to record a receive, and a **settled:**
  one-liner listing zero-balance people. Clicking a name opens their full
  posting history ([Person modal](#11-people-splits--reimbursements)).
- **Investments** — balances with reconcile.
- **Loans** — outstanding (sign-flipped so owed reads positive) with
  reconcile.

## 10. The Plan page

Route `/plan`. Future months only: starts at **next month** and only goes
forward (`back to next month` shortcut appears when you've wandered). The
premise: *this* month's dues are assumed to be paid this month; Plan shows
what lands afterwards.

### Stats row

Five cards, same brain as the Book but for the plan month *m*:

| Stat | Formula |
|---|---|
| **Coming in** | Σ income templates active in m + one-off planned income in m |
| **Cash committed** | Σ non-income/non-internal/non-card templates active in m + one-off planned spends in m |
| **Card dues landing** | Σ projected statements due in m ([cycle math](#8-credit-cards--statement-cycles)) |
| **Coming back** | Σ template reimbursements + one-off repayments in m |
| **Left ⓘ** | coming in − cash committed − card dues + coming back |

The **Left ⓘ** modal shows the per-month breakdown and the carry-over
caveat (swipes in m that bill later belong to m+1).

### Projected liquid line

> Liquid today ₹X → projected by end of March 2027: ₹Y

`liquid today` = Σ balances of `is_liquid` accounts. The projection adds
**every month's `left`** from next month through the viewed month — so
browsing farther into the future accumulates each intermediate month's
surplus/deficit. Ad-hoc (unplanned) spending is explicitly not included.

### Card dues section

Per card landing a due in the month: `bills 27 Feb, due 15 Mar`, the
projected total, and its composition (`₹X already swiped + ₹Y recurring to
come + ₹Z planned one-offs`), or the estimate-only caveat for far-future
cycles.

### One-offs section

Month-specific planned items — a premium, a trip, a bonus. Same table
columns as the Book, with an add row (dates default to the 1st of the plan
month) and fully inline-editable rows. Implementation: these are ordinary
**pending transactions** dated in that month, so when the month arrives they
appear in the Book automatically as planned entries — nothing to migrate,
nothing duplicated. Classified by their postings into income / spend /
repayment / card swipe / internal, and fed into the stats above.

### Every month section

The recurring-template registry: `every 5th`, name, from → to, signed
amount, reimbursement note (`Rahul returns ₹8,500.00`), EMI progress, and a
pencil to edit. EMIs outside their window for the viewed month dim out with
an explanation. `+ recurring` opens the template form. Posting and paying
always happen in the Book — Plan never moves money.

## 11. People, splits & reimbursements

A person is an asset account (`receivable`). Positive balance = they owe
you; negative = you owe them.

Ways money gets onto a person:

1. **Direct entry** — `credit card → Person` (their EMI hit your card), or
   `bank → Person` (you lent cash).
2. **Split on an entry** — three-leg posting; your expense shrinks by their
   share.
3. **Template reimbursement** — a recurring item where someone repays part
   every month (e.g. you pay a ₹17,000 EMI, a friend returns ₹8,500 around
   the 5th). Generates a monthly **receive row** in the Book, feeds "coming
   back" in both screens' math.
4. **You owe them** — entries like `Person → bank` push their balance
   negative; recurring paybacks are just templates `bank → Person`.

**Receiving** money is `Person → liquid bank`. The receive row
auto-completes when the month's credits to that person reach the expected
amount.

**Person modal** (click a name): their full posting history — date, entry,
signed amount, pending markers — with a plain-words balance line
(`Owes you ₹8,500.00 · positive = they owe more, negative = they paid back`).

## 12. Envelopes & budgets

- **Envelope**: an asset account under a bank — money set aside inside the
  same real-world account (e.g. a "Home" envelope inside a savings bank). The bank's sidebar
  total includes envelopes (that money *is* in the bank); `free ₹X` shows
  the bank's own unallocated balance. Book transfers `bank → envelope` to
  set aside, the reverse to release.
- **Budget template** (`is_budget`): a recurring transfer to another
  account that is *really* spending — a monthly household transfer, a
  personal allowance. Normally asset→asset transfers are "internal" and
  excluded from committed spend; the budget flag forces them to count as
  cash committed in both Book and Plan.

## 13. Liquidity

`accounts.is_liquid` — per-account, user-controlled, never inferred from
names:

- **Liquid totals**: "Liquid today" and the projected-liquid accumulation on
  Plan sum only liquid accounts.
- **Destination lists**: receive-money flows offer only liquid accounts.
- **Cover**: offered only when the paying account is liquid; sources are
  the other liquid accounts.

Defaults on creation (bank/cash/envelope → liquid) are just a convenience —
the checkbox on any asset account is the source of truth. A salary account
in a bank you never spend from can be non-liquid; a liquid mutual fund can
be liquid.

## 14. Reconciliation

Every account block has a ⚖ button: type the real balance from your
bank/card app (for cards and loans: the outstanding). Munshi stores it
(signed by kind) with a timestamp and **shows the gap** against the logged
balance — `+₹120.00 vs bank` on accounts, `₹450.00 unlogged on card` /
`over-logged` on cards. It never auto-corrects; the gap is a to-do, not an
adjustment.

## 15. Multiple & shared ledgers

One account, many books (VISION §2–§3):

- **`ledgers`** — each is a fully isolated set of accounts, transactions,
  templates, and members. Every data row (`accounts`, `transactions`,
  `postings`, `recurring_templates`) carries a non-null `ledger_id`.
  Postings inherit their transaction's ledger and child accounts (envelopes,
  sub-cards) inherit the parent's — both via `before insert` triggers.
- **`ledger_memberships`** — `(ledger_id, email, role)` with roles
  `owner` / `editor` / `viewer`. Membership is by email so someone can be
  invited before their first sign-in.
- **RLS**: `is_ledger_member(ledger_id)` gates all reads;
  `can_write_ledger` (owner or editor) gates writes — a viewer is read-only
  at the database level. `ledger_memberships` itself has **no policies**;
  security-definer RPCs are the only door: `ledger_create(name)` (caller
  becomes owner), `ledger_members_list(l)`, `ledger_member_add(l, email,
  role)` and `ledger_member_remove(l, email)` (owner-only; you can't remove
  yourself).
- **UI**: the nav shows a **ledger switcher** (book icon) — switch, rename,
  or create a ledger; the active ledger id persists in
  localStorage (`munshi-active-ledger`) and every screen is scoped to it.
  Click your email → **Members** modal for the active ledger: list with
  roles, add (owners pick a role), remove (with confirm).
- Migration 008 folds the old email-list model in: the shared group becomes
  one "Personal" ledger (members as owners); any other user gets a private
  ledger of their own. A brand-new user's first sign-in auto-creates
  "Personal" via `ledger_create`.

## 16. Authentication

- Google OAuth via Supabase (`signInWithOAuth`, redirect to
  `/auth/callback`, code exchanged server-side for a session).
- No app-level allow-list. Anyone with a Google account can sign in, and
  lands in their own private ledger: RLS scopes every table through
  `is_ledger_member(ledger_id)`, so a stranger is a member of nothing and
  sees an empty app. An `ALLOWED_EMAILS` check used to live in
  `/auth/callback`; it was removed because it failed open when unset, ran
  only after the `auth.users` row had already been created, and was never
  re-checked per request. Restricting who may sign up belongs on
  `auth.users` in Postgres, where it cannot fail open.
- The app layout redirects unauthenticated visitors to `/login`.

## 17. UI component system

No native form controls anywhere — everything is custom, ledger-styled, and
keyboard-first. All dropdown panels are **fixed-positioned** so they escape
the table's `overflow-x-auto` scroll wrappers, flip upward near the viewport
bottom, and close on outside click, scroll, resize, or Escape.

- **`Select`** — replaces `<select>`: type-to-filter search box, grouped
  options with uppercase group labels, arrow-key navigation, Enter selects,
  check mark on the current value. `chrome` prop switches between a bordered
  form field and a bare table-cell trigger.
- **`AccountSelect`** — a `Select` over accounts, grouped: Banks, Set
  aside, Cash, Cards, Categories, People, Loans, Income, Investments;
  children (envelopes, sub-cards) carry a `·` hint. `allowCreate` appends
  `＋ New category…`.
- **`DateInput`** — replaces `<input type=date>`: trigger reads `06 Aug`
  (year appended only when not the current year); panel is a compact
  **Monday-first** calendar with month paging, today outlined, selection
  filled.
- **`TitleInput`** — creatable combobox for entry titles: suggestions from
  the last 400 transactions, deduplicated by title, ranked by frequency
  (`×7` badges), filtered as you type. Picking one prefills the from/to
  accounts and tag from how that title was last booked; free text is always
  allowed (Enter with nothing highlighted just saves the row).
- **`Modal` / `InputModal`** — Escape/backdrop closing, `wide` variant;
  `InputModal` is the one-field prompt (reconcile, post, new person, new
  category) with select-all autofocus and Enter-to-submit.
- **Icons** — lucide throughout: Pencil (edit), Scale (reconcile), Users
  (split), ArrowLeftRight (cover), HandCoins (receive), RotateCcw
  (un-pay), Settings2 (categories), Plus, X, Check, Chevrons.
- **Tables** — the `ledger-grid` shares one column layout across every
  table in the app; bare inputs fill cells so editing looks like writing in
  a ledger.

## 18. Formatting & display rules

- Dates render as `01 Aug` (en-IN, 2-digit day, short month); person
  history adds a 2-digit year; month titles are `August 2026` in a
  fixed-width slot so nav arrows never move.
- Amounts: always two decimals, Indian grouping, `amount` class
  (tabular/monospace styling).
- Colour language: green `text-ledger` = money in / good; red `text-debit`
  = money out / overdue / owed; amber `text-pending` = planned/tagged;
  faint ink for metadata. Overdue rows get a soft red wash; pending rows a
  soft amber wash; quick-add a soft green wash.
- Signs: income `+`, spends `−`, internal transfers unsigned grey with `⇄`.
- Responsive: the ledger keeps a minimum width and scrolls horizontally on
  mobile; the sidebar drops below the table; stats wrap.

## 19. Architecture & deployment

- **Next.js App Router** (v16) + Tailwind v4, all ledger pages are client
  components on a thin server-checked layout.
- **Supabase** — Postgres, Google auth, RLS. The browser talks to Postgres
  directly through supabase-js (no app API layer); balances and card cycles
  are SQL views (`security_invoker`), so the database is the single source
  of truth for balance math.
- `useLedger()` — one shared hook loading accounts + balances + cycles;
  pages load their own transactions/templates per month and refresh both
  after every write.
- **Deploy**: GitHub → Vercel (auto-deploy on push to `main`) → custom
  domain behind Cloudflare DNS. Environment: `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` (see `.env.example`), plus
  `SUPABASE_SERVICE_ROLE_KEY` and the three `MCP_*` secrets for the MCP
  endpoint. Supabase Auth URL Configuration must list the production
  domain (Site URL + redirect allow-list).
- Personal seed data lives in `supabase/seed/` which is **gitignored** —
  the repository is public and carries no personal or financial data.

## 20. Database migrations

| File | What it does |
|---|---|
| `001_init.sql` | Core schema: account/transaction/posting/template tables, enums, balanced-transaction deferred trigger, `account_balances` view, per-user RLS |
| `002_shared_ledger.sql` | `ledger_members` + `is_shared_row()`; RLS policies widened to own-or-shared |
| `003_tags_cycles.sql` | `transactions.tag` (constrained), `stmt_cutoff()` and the `card_cycle_balances` view |
| `004_free_tags.sql` | Drops the tag constraint — tags become free text |
| `005_budget_flag.sql` | `recurring_templates.is_budget` |
| `006_member_functions.sql` | Member-management RPCs (list/add/remove), security-definer, member-gated |
| `007_liquid_flag.sql` | `accounts.is_liquid` + backfill (bank/cash/envelope → true) |

## 21. Testing

Two layers, both runnable locally.

### Unit tests — `npm test` (Vitest)

All calculation logic lives in pure modules so it can be tested directly;
the Book and Plan pages call the same functions they render
(`src/lib/calc.ts` is the shared brain).

| Suite | Covers |
|---|---|
| `money.test.ts` | paise formatting (two decimals, Indian grouping, no negative zero), rupee parsing (₹/commas/spaces, rounding, invalid input), format→parse round-trips |
| `emi.test.ts` | installment indexing across year boundaries, window boundaries (first/last/±1 month), end-date derivation with short-month clamping, single-installment EMIs |
| `ledger.test.ts` | display-sign flipping by account kind, recursive subtree balances (settled/pending fields), envelope free-money split, next-occurrence day clamping incl. leap years, date helpers |
| `postings.test.ts` | two-leg and three-leg (split) posting construction, reimbursement clamping, zero-leg avoidance, always-balances property |
| `calc.test.ts` | template classification (income/internal/budget/lending), one-off classification, card subtree math, current-cycle due/unbilled, projected statement windows (same-month and next-month dues, open vs. future windows, carry-over, EMI last-installment landing, ended-EMI exclusion, far-future months), full month-plan totals, liquid totals, multi-month projected-liquid accumulation |

### Database checks — `npm run test:db`

`supabase/tests/db_checks.sql` runs against a real Postgres via
`DATABASE_URL` (never stored anywhere). Every statement executes inside
**one transaction that ends in `ROLLBACK`** — the target database is left
untouched, so it is safe to point at any environment. Fixtures use fixed
UUIDs and `@example.invalid` emails that cannot collide with real data.

It verifies, at the database level:

- the deferred balanced-transaction trigger (accepts balanced two- and
  three-leg entries, rejects unbalanced ones — exercised with
  `SET CONSTRAINTS ... IMMEDIATE`, which fires the check without committing)
- check constraints: nonzero postings, statement/due/template day bounds,
  positive template amounts, free-text tags
- delete behaviour: transaction→postings cascade, account deletion
  restricted while postings exist
- `account_balances` (settled vs. pending split), `stmt_cutoff`
  (never future, never older than a month, day clamped to month end), and
  `card_cycle_balances` (billed vs. payments vs. unbilled around the
  cutoff, pending swipes excluded, sub-card cutoff inheritance)
- RLS: owners see their rows, strangers see nothing (tables *and* views),
  `auth.uid()` defaults applied on insert, `ledger_members` closed to
  direct writes
- shared-ledger RPCs: non-members refused, members see and edit each
  other's rows, add lower-cases emails, garbage emails rejected,
  self-removal refused, removal works
