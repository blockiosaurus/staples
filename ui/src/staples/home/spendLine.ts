import type { BriefingSpend } from "@paperclipai/shared";
import { formatDollars as dollars } from "@/lib/utils";

/**
 * Home's one spend line: "$12 of $90 this month" against the company budget,
 * the hosted limit's use when there is one ("· $8 of $50 hosted limit"), and
 * "· no limit set" when neither exists.
 */
export function spendLineText(spend: BriefingSpend): string {
  const month = spend.companyBudgetCents !== null
    ? `${dollars(spend.monthSpendCents)} of ${dollars(spend.companyBudgetCents)} this month`
    : `${dollars(spend.monthSpendCents)} this month`;
  if (spend.hosted) return `${month} · ${dollars(spend.hosted.spentCents)} of ${dollars(spend.hosted.capCents)} hosted limit`;
  return spend.companyBudgetCents !== null ? month : `${month} · no limit set`;
}
