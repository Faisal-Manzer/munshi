# Munshi — personal double-entry finance

Tracks bank accounts, credit cards (with sub-cards billed to a parent), EMIs,
recurring expenses, envelopes (money set aside inside a bank account), money
lent to people, and shared loans — all as balanced double-entry bookkeeping,
in INR.

## Stack

- Next.js (App Router) + Tailwind v4
- Supabase — Postgres, Google auth, RLS (all rows scoped to your user)
- Amounts stored as integer paise; postings are debit `+` / credit `-` and a
  deferred trigger rejects any transaction that doesn't sum to zero.

## Setup

1. **Supabase project** — already created. Schema is applied from
   `supabase/migrations/001_init.sql`. To re-apply on a fresh project:

   ```sh
   psql "postgresql://postgres:<DB_PASSWORD>@db.<ref>.supabase.co:5432/postgres" \
     -f supabase/migrations/001_init.sql
   ```

2. **Google login** — in the Supabase dashboard: *Authentication → Sign In /
   Up → Google → Enable*. Create an OAuth client in Google Cloud Console
   (type: Web application) with redirect URI
   `https://<ref>.supabase.co/auth/v1/callback`, paste client ID/secret into
   Supabase. Add every email you use to `ALLOWED_EMAILS` in `.env.local` —
   anyone else is signed out at the door.

3. **Run locally**

   ```sh
   npm install
   npm run dev
   ```

4. **Deploy (Vercel)** — import the repo, set the three env vars from
   `.env.example`, deploy. Then add your Vercel URL to Supabase:
   *Authentication → URL Configuration → Site URL / Redirect URLs*
   (`https://your-app.vercel.app/auth/callback`).

## How the books work

Every row you enter is one balanced transaction: **From** is credited, **To**
is debited.

| You did | From | To |
|---|---|---|
| Groceries on card | credit card | expense category |
| Paid card bill | bank | credit card |
| Moved money between banks | bank A | bank B |
| Set money aside | bank | its envelope |
| Salary landed | salary | bank |
| Brother's EMI hit your card | credit card | Brother (person) |
| Business EMI, partner owes half | bank → *Split with: Partner, their ₹* | expense |
| Partner paid you back | Partner (person) | bank |

- **Sub-cards**: create them with a parent card; their spends roll up into the
  parent's due amount on the Overview.
- **Recurring/EMIs**: templates carry the payment mechanics (bank auto-debit,
  card auto-debit, manual, pay-before-due). "Post" creates a *pending* entry;
  mark it paid when the money actually moves — that's your "did I pay the
  loan" trail. EMIs can carry total installment counts and an expected
  repayment (who pays you back, how much, around which day).
- **Reconcile**: on Accounts, "reconcile" stores the real balance from your
  bank/card app; the gap vs. your logged balance is shown, never auto-fixed.
- **Overview**: pick a month — expected salary vs. committed outflows, card
  bills in due-date order, a day-by-day cash-flow calendar, and who owes you.
