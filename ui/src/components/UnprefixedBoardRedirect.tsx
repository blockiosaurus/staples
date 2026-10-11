import { Navigate, useLocation } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { PaperclipLoading } from "./AnimatedPaperclipIcon";

export function UnprefixedBoardRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();

  if (loading) {
    return <PaperclipLoading />;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    return <Navigate to="/start" replace />;
  }

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${location.pathname}${location.search}${location.hash}`}
      replace
    />
  );
}
