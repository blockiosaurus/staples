import { Navigate, useParams } from "@/lib/router";
import { PaperclipLoading } from "@/components/AnimatedPaperclipIcon";
import { useCompany } from "@/context/CompanyContext";

/**
 * The retired `/onboarding` and `/:prefix/onboarding` routes. Old links and
 * bookmarks land in the company's Assistant, or on `/start` when there is no
 * company to land in.
 */
export function OnboardingRedirect() {
  const { companies, selectedCompany, loading } = useCompany();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();

  if (loading) return <PaperclipLoading />;

  const target =
    (companyPrefix
      ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase())
      : null) ??
    selectedCompany ??
    companies[0] ??
    null;

  return <Navigate to={target ? `/${target.issuePrefix}/assistant` : "/start"} replace />;
}
