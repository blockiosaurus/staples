import { useEffect, useRef, type ComponentProps } from "react";
import { useLocation, useNavigate } from "@/lib/router";
import { CompanySwitcher } from "@/components/CompanySwitcher";
import { SidebarAccountMenu } from "@/components/SidebarAccountMenu";
import { useCompany } from "@/context/CompanyContext";
import { BrandStarterCard } from "./BrandStarterCard";
import { AssistantConversation } from "./AssistantConversation";
import { useAssistantShell } from "./AssistantProvider";
import { useAssistant } from "./useAssistant";

/**
 * Stage 0: a company with no staff agents yet. The Assistant is the whole
 * app: no sidebar and no dock, just the company switcher, the account menu,
 * and the conversation (with its opening bubble while the thread is empty).
 */
export function StageZeroShell({ deploymentMode }: { deploymentMode?: ComponentProps<typeof SidebarAccountMenu>["deploymentMode"] }) {
  const location = useLocation();
  const navigate = useNavigate();
  const shell = useAssistantShell();
  const { selectedCompany } = useCompany();
  const { setup } = useAssistant({ withConversation: false });
  const firedRef = useRef(false);
  const firstMessage = (location.state as { firstMessage?: string } | null)?.firstMessage;
  // The thread keeps a sent ask as a plain draft while setup is still starting
  // (the composer is replaced by the setup card), so wait for setup to be ready.
  const ready = !!shell?.available && setup?.state === "ready";
  const askAssistant = shell?.askAssistant;
  useEffect(() => {
    if (!firstMessage || firedRef.current || !ready || !askAssistant) return;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const sent = askAssistant({
      text: firstMessage,
      send: true,
      context: { label: `Sent from the start page. Time zone ${zone}, language ${navigator.language}`, href: "/start" },
    });
    if (sent) {
      firedRef.current = true;
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [firstMessage, ready, askAssistant, navigate, location.pathname]);

  return (
    <div data-testid="stage-zero-shell" className="flex h-dvh flex-col bg-background pt-(--sz-safe-top) text-foreground">
      <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5">
        <div className="w-56 min-w-0">
          <CompanySwitcher />
        </div>
        <div className="w-56 min-w-0 overflow-hidden rounded-lg">
          <SidebarAccountMenu deploymentMode={deploymentMode} forceExpanded />
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="streamlined-task-detail-surface flex min-h-0 flex-1 flex-col outline-none"
      >
        <div className="px-3 pt-3">
          <BrandStarterCard key={selectedCompany?.id} />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <AssistantConversation opening />
        </div>
      </main>
    </div>
  );
}
