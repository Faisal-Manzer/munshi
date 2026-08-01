export type AccountKind = "asset" | "liability" | "income" | "expense" | "equity";

export type AccountSubtype =
  | "bank"
  | "envelope"
  | "cash"
  | "investment"
  | "receivable"
  | "credit_card"
  | "loan"
  | "salary"
  | "other_income"
  | "general_expense"
  | "opening_balance";

export interface Account {
  id: string;
  user_id: string;
  name: string;
  kind: AccountKind;
  subtype: AccountSubtype;
  parent_id: string | null;
  statement_day: number | null;
  due_day: number | null;
  credit_limit_paise: number | null;
  person_name: string | null;
  reported_balance_paise: number | null;
  reported_at: string | null;
  sort_order: number;
  archived: boolean;
}

export type TxnStatus = "pending" | "done";

export interface Transaction {
  id: string;
  date: string; // yyyy-mm-dd
  description: string;
  status: TxnStatus;
  recurring_template_id: string | null;
  reimburse_account_id: string | null;
  reimburse_amount_paise: number | null;
  notes: string | null;
}

export interface Posting {
  id: string;
  transaction_id: string;
  account_id: string;
  amount_paise: number; // debit +, credit -
}

export type RecurringKind =
  | "autodebit_bank"
  | "autodebit_cc"
  | "manual"
  | "pay_before_due";

export interface RecurringTemplate {
  id: string;
  name: string;
  kind: RecurringKind;
  day_of_month: number;
  amount_paise: number;
  from_account_id: string;
  to_account_id: string;
  reimburse_account_id: string | null;
  reimburse_amount_paise: number | null;
  reimburse_expected_day: number | null;
  total_installments: number | null;
  installments_done: number;
  start_date: string | null;
  end_date: string | null;
  active: boolean;
  notes: string | null;
}

export interface AccountBalance {
  account_id: string;
  balance_paise: number;
  settled_paise: number;
  pending_paise: number;
}

export const RECURRING_KIND_LABEL: Record<RecurringKind, string> = {
  autodebit_bank: "Auto-debit from bank",
  autodebit_cc: "Auto-debit on card",
  manual: "Manual payment",
  pay_before_due: "Pay before due date",
};
