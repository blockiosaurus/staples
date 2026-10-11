import { useEffect } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { NewAgentSetup } from "../components/new-agent/NewAgentSetup";

export function NewAgent() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([
      { label: "Agents", href: "/agents" },
      { label: "Hire an agent", href: "/agents/new" },
      { label: "Build your own" },
    ]);
  }, [setBreadcrumbs]);
  return <NewAgentSetup />;
}
