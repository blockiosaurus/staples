# Phase 6 final fix wave: report

## Part 1: server security (items 1–8)

Base 9d34dbfa5. Commits: 639e4d322 (items 2, 3, 6), 4cee960f6 (item 1), a7e8a2cc4 (items 4, 5), 72150122e (item 7), e65b82e73 (item 8).

### 1. Guard rows cannot be deleted (A-I1, A-M9)
- **Change:** `deletePolicy` refuses rows whose `config.source` is `agent_template` with 422 "This rule protects a hired agent; change the agent instead." It also refuses `agent_autopilot` markers with 422 "...change it from the agent's Autopilot panel instead." Generic PATCH on both kinds now accepts only name and description. Any `enabled` change is refused, so markers are switched only through PUT /autopilot, which checks `agent_config:update`. An unchanged `enabled` value is ignored.
- **UI:** the only policy list in `ui/src` is AgentToolsTab "Active policies". It has no edit, delete or toggle controls. Server-owned rows there now show "Managed by <agent>'s template" or "Managed by <agent>'s Autopilot settings" (`serverOwnedPolicyNote`).
- **Files:** server/src/services/tool-access-policy.ts, ui/src/pages/AgentToolsTab.tsx.
- **Tests:**
  - tool-access-policy-service: new test "refuses to delete or switch off server-owned template guards and Autopilot markers".
  - agent-autopilot: the stale-marker test now asserts that generic PATCH and DELETE are refused and a rename works.
  - AgentToolsTab.test: checks the managed note.

### 2. Name patterns apply to read-rated tools (A-I2)
- **Change:**
  - `templateDestructiveGuardApplies` applies `destructiveToolPatterns` whatever the risk rating. The only exemption is a read-rated, low-rated or unrated call whose names all pass the strict read-only check.
  - The template outward rule and Autopilot markers now match by name through `policySelectorMatches` and `templateOutwardRiskApplies`, ignoring their stored `riskLevels`. They match write or medium risk, plus read-rated or unrated calls that are not plainly read-only. They never match destructive, high or critical risk.
  - Existing seeded rows benefit without a migration.
- **Files:** server/src/services/tool-access-policy.ts.
- **Tests:** new test "applies template name patterns to read-rated tools unless the name is plainly read-only".
  - Read-rated `close_issue` and `trash_message` hit the guard.
  - `merge_pull_request`, `push_files`, `reply_to_message` and `schedule_post` (read-rated and unrated) hit the outward rule.
  - `list_issues` and `search_posts` are allowed.
  - Autopilot lifts the read-rated and medium outward calls, but never the destructive guard.

### 3. Read-only verb match uses the first verb segment (C, A-M7)
- **Change:** `toolNameIsReadOnlyVerb` splits names on separators and camelCase. The first verb-like word (read or mutating, which skips namespace prefixes) must be a read verb, and no word may be in `MUTATING_TOOL_VERBS` (the brief's list). The "lead with" comments are fixed in tool-access-policy.ts and plan-templates.ts.
- **Tests:**
  - The allowlist unit test now also denies `refund_list`, `delete_saved_search`, `get_and_charge`, `refund_and_get_receipt`, `stripe_cancel_list`, `list_and_send` and `getAndUpdateCustomer`.
  - It still allows `stripe_list_charges`, `listRefunds` and the existing list.

### 4. No delegation from templated agents (A-I3)
- **Change:**
  - `planHireBody` sends `permissions: { canCreateAgents: false }` for every templated hire, plus `canAssignTasks: false` for read-only templates.
  - The hire route's default `tasks:assign` grant (`applyDefaultAgentTaskAssignGrant`) is skipped when `canAssignTasks === false`. So are the standard grant keys `tasks:assign` and `tasks:assign_scope`, in `initializeAgentHire` and `completeAgentHireApproval` through the new `newStandardAgentGrantKeys`.
- **Files:** server/src/services/plans.ts, server/src/routes/agents.ts, server/src/services/agent-hiring.ts, server/src/lib/agent-permissions.ts.
- **Tests:** plans-apply-routes "hires templated agents without delegation...". The bookkeeper has `canCreateAgents:false` and `canAssignTasks:false`, and no `tasks:assign` or `tasks:assign_scope` grant. The coding agent has `canCreateAgents:false` and keeps `tasks:assign`.

### 5. Held until template setup succeeds (A-I4)
- **Change:**
  - After a templated hire, plans/apply writes the template record with `setupPending: true`. A non-pending hire also gets a `template_setup` lifecycle hold (`createAgentLifecycle(db).pauseAgent(id, "template_setup")`), which pauses it with `pauseReason "template_setup"` until released.
  - When setup succeeds, `ensureTemplateAgentSetup` rewrites the record without `setupPending`, and the hold is released with `resumeAgent(id, "template_setup")`.
  - If setup fails, the partial-apply error ends with "<name> stays paused until its template setup finishes."
  - A pending-approval hire cannot take a lifecycle hold. `prepareAgentHireApproval` instead refuses activation while `setupPending` is set (409 `agent_template_setup_pending`).
  - Re-applying the plan finishes setup and releases the hold.
  - `template_setup` is added to `PAUSE_REASONS` in shared constants.
- **Files:** server/src/services/plans.ts, server/src/services/agent-hiring.ts, packages/shared/src/constants.ts.
- **Tests:** plans-apply-routes, two new tests.
  - "holds a templated agent paused until its guards exist; re-applying finishes setup and releases it". A same-named policy forces seeding to fail. The test checks paused, `template_setup`, `setupPending` and the message, then re-applies and checks the hold is cleared, the record is clean and two rules exist.
  - "keeps a pending hire approval from activating a templated agent whose setup did not finish".

### 6. ReDoS in policy argument conditions (A-M5)
- **Change:**
  - `decide()` filters policies by selector before it evaluates any conditions.
  - `argumentFiltersMatch` never tests a string longer than `POLICY_REGEX_MAX_INPUT_LENGTH` (2,000), or a pattern `isSafePolicyRegex` refuses, which covers legacy rows.
  - For non-allow policies (block, ask first, rate limit), an over-long argument or unsafe pattern denies the call. Treating it as no match would let the call slip past. For an allow policy it is simply no match.
  - `isSafePolicyRegex` now also does a structural scan. It refuses a quantified group whose body is quantified (`(a?){25}`, `((a)+)+`). It refuses adjacent overlapping unbounded repeats (`\w+\w+`, `.*.*`). It refuses three or more mutually overlapping unbounded repeats (`[\w.-]+\.[\w.-]+\.\w+`). `{n,m}` above 16 counts as unbounded. Overlap is computed by testing a sample alphabet.
- **Tests:** tool-access-policy-service, two new tests.
  - Unsafe patterns rejected: `(a?){25}a{25}`, `^\w+\w+\w+$`, `\w+\w+$`, the dotted chain, `((a)+)+`, `(?:a*)*`, `.*.*=.*`. Safe patterns accepted: `^[\s\S]{1,200}$`, `^[a-z0-9_-]+$`, `^acct_\w+$`, `^(?:foo)?bar\d{2,4}$`, `^[^@]+@example\.com$`.
  - A legacy unsafe row on another tool is never evaluated. A 10,000-character argument fails closed on a block.

### 7. markDefaults key (C, A-M6)
- **Change:** `upsertAskFirstPolicies` marks `defaultAskFirst` only when no `app_gallery_finish` rows exist for the connection (first-ever finish). The caller's status check is kept as well, so both must hold.
- **Files:** server/src/services/tool-access.ts.
- **Tests:** in the tool-access-service gallery finish test, the connection is set back to draft and re-finished, and the explicit Ask first row is still not marked. The old code would have re-marked it.

### 8. Owner fallback (A)
- **Change:** `decidePrincipalGrant`'s role-default fallback for owner and admin users now covers `agents:configure` as well as `tools:*`.
- **Files:** server/src/services/authorization.ts.
- **Tests:** agent-autopilot "owners and admins without seeded grants can use Autopilot from their role; operators cannot". Legacy memberships get GET and PUT 200 for owner and admin, and 403 for operator.

### Verification
- Typecheck exit 0 for shared, server and ui.
- `pnpm check:token-gates`: clean.
- Server test results:

  | Suite | Result |
  |---|---|
  | tool-access-policy-service | 50/50 |
  | tool-access-service | 420/420 |
  | agent-autopilot | 10/10 |
  | plans-apply-routes | 47/47 |
  | plans-apply-app | 1/1 |
  | agent-permissions-service | 9/9 |
  | agent-permissions-routes | 88/88 |
  | assistant-interview-plan-e2e | 1/1 |
  | authorization-service | 70/70 |
  | tool-gateway-service | 39/39 |
  | agent-template-install-e2e | 1/1 |
  | agent-template-routes | 6/6 |
  | agent-templates | 25/25 |

- UI: AgentToolsTab 7/7, run with `--testTimeout=30000`. The first run timed out at load average ~50, including in an untouched test.

### Concerns / notes
- The strict read-only verb list includes `issue`, `record`, `set` and `add`. A read-only agent is therefore denied names such as `get_issue` or `get_record` (fails closed). Stripe read tools are unaffected.
- A fresh templated hire is idle for a moment between the hire committing and the hold being applied, before it has tasks. A board user's ordinary "resume" also clears the `template_setup` hold, because user resumes clear non-policy holds.
- New templated agents still receive the standard direct grants, including `tools:manage_profiles`, `tools:manage_connections` and `agents:configure`. Whether an agent can use those to weaken another agent's access is outside this wave. Worth a follow-up review.
- UI copy for the `template_setup` pause reason is not added (Part 2 or later). It shows as a generic paused state.

## Part 2 — item 14

GET /api/agents/:id/autopilot now returns `remembered: [{policyId, toolName}]` per category (active, enabled agent-scoped trust rules naming a tool matching the category patterns, on its connection). The Autopilot panel shows "Some actions are always allowed (remembered)", the tool names, a "Manage in Tools" link (agent tools tab) and an "Ask first again" revoke button. OpenAPI description updated. Tests: agent-autopilot 11/11, AutopilotPanel 17/17, openapi-routes 22/22; server+ui typecheck and token gates clean.
