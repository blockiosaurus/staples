import { Navigate, useLocation } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { shouldRedirectCompanylessRouteToOnboarding } from "../lib/onboarding-route";
import { useCloudInstance } from "../hooks/useCloudInstance";
import { cloudStackCreateUrl } from "../lib/cloudLinks";
import { navigateTopLevel } from "@/lib/browserNavigation";
import { PaperclipLoading } from "./AnimatedPaperclipIcon";

export function UnprefixedBoardRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();

  if (loading) {
    return <PaperclipLoading />;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${location.pathname}${location.search}${location.hash}`}
      replace
    />
  );
}

export function NoCompaniesStartPage() {
  const { openOnboarding } = useDialogActions();
  const { t } = useTranslation();
  // A managed stack with no visible companies is a loading or error state, not
  // an invitation to create one in-app — creation lives on Cloud (403 floor).
  const cloudInstance = useCloudInstance();
  const createStackUrl = cloudStackCreateUrl(cloudInstance?.cloudBaseUrl ?? null);

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">
          {t("app.noCompanies.title", { defaultValue: "Create your first organization" })}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("app.noCompanies.description", { defaultValue: "Get started by creating an organization." })}
        </p>
        <div className="mt-4">
          {/* Same as the onboarding route: no Cloud origin means nowhere to
              send the click, and in-app creation is a 403 floor here. */}
          {cloudInstance && !createStackUrl ? (
            <p className="text-sm text-muted-foreground">
              {t("app.cloudCreateUnavailable", {
                defaultValue:
                  "Organizations are created in Paperclip Cloud. This instance can't reach it right now — try again from your Cloud portfolio.",
              })}
            </p>
          ) : (
            <Button
              onClick={() =>
                cloudInstance && createStackUrl
                  ? navigateTopLevel(createStackUrl)
                  : openOnboarding()
              }
            >
              {t("app.noCompanies.newCompany", { defaultValue: "New Organization" })}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
