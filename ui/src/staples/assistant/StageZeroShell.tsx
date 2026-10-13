import type { ComponentProps } from "react";
import { CompanySwitcher } from "@/components/CompanySwitcher";
import { SidebarAccountMenu } from "@/components/SidebarAccountMenu";
import { AssistantConversation } from "./AssistantConversation";

/**
 * Stage 0: a company with no staff agents yet. The Assistant is the whole
 * app: no sidebar and no dock, just the company switcher, the account menu,
 * and the conversation (with its opening bubble while the thread is empty).
 */
export function StageZeroShell({ deploymentMode }: { deploymentMode?: ComponentProps<typeof SidebarAccountMenu>["deploymentMode"] }) {
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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <AssistantConversation opening />
        </div>
      </main>
    </div>
  );
}
