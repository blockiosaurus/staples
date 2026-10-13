import { AuditHub } from "./AuditHub";

/**
 * Canonical `/:company/activity` entrypoint for the Audit hub. Runs, Costs,
 * Budgets, and Timeline live as peer sections; the hub owns the all-actors and
 * privileged Agent Actions modes (`?mode=`) so `/audit` deep links can preset
 * them and links stay shareable. The server enforces both tiers.
 */
export function CompanyActivity() {
  return <AuditHub section="activity" />;
}
