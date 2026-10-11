export interface CompanySignals {
  companyId: string;
  /** Non-terminated agents, excluding built-in agents (metadata key "paperclipBuiltInAgent"). */
  agents: number;
  /** Visible execution issues in any status. */
  tasks: number;
  /** Visible execution issues not in done/cancelled. */
  openTasks: number;
  /** Projects with archivedAt null. */
  projects: number;
  /** All goals for the company. */
  goals: number;
  /** Routines whose status is not "archived". */
  routines: number;
  /** Agent-authored non-system issue documents, paperclip artifact work products, and standalone agent-created attachments (deduped against work products), on visible issues. */
  artifacts: number;
  /** Company skills whose key does not start with "paperclipai/paperclip/". */
  extraSkills: number;
  /** All tool_connections rows for the company. */
  connections: number;
  /** issue_thread_interactions with kind "connection_intent", any status. */
  connectionRequests: number;
  /** Approvals in any status. */
  approvalsEver: number;
  /** Interactions of kinds suggest_tasks, ask_user_questions, request_confirmation, request_checkbox_confirmation, request_item_verdicts, any status. */
  questionsEver: number;
  /** True when companies.budget_monthly_cents > 0 or any active budget policy has amount > 0. */
  budgetSet: boolean;
  /** Sum of cost_events.cost_cents since the start of the current UTC month. */
  monthSpendCents: number;
  /** True when the company brief exists and is not blank. */
  hasBrief: boolean;
  generatedAt: string;
}
