# Staples UX review: path to a sellable product for people starting a business

Date: 2026-10-14
Status: analysis, not a plan. Items are candidates to pick from.

## Method

Walked the live dev build (`staples-dev-hosted`, data dir `tmp/staples-hosted2`) as a
new user: the existing Lantern Candle Co company (Home, Assistant, task pages,
agent detail, Hire an agent, Tasks, Costs, Connectors, Inbox, Skills, Company
brief, Settings), then created a fresh company ("UX Review Bakery", left in the
dev data) and sent one interview message. Checked phone width on Home and a
task page. Read the adaptive-UX design, Phase 9 and Railway plans, and the
relevant UI code.

Impact scale: **Critical** blocks selling to anyone; **High** most new users
hit it in week one; **Medium** polish that lifts trust or retention.
Effort: S under a day, M a few days, L one to two weeks, XL multi-week.
Reach: who hits it. Type: Bug, Copy, Flow, Feature, Platform.

## The table

| # | Improvement | Impact | Effort | Reach | Type | What I saw | Proposal |
|---|---|---|---|---|---|---|---|
| 1 | Block the first message until the Assistant is ready | Critical | S | Every new company | Bug | Composer stayed enabled under "Assistant is still being set up…". My first message ran without tools; the reply said "The card tool and the company tools aren't available… nothing here connects to the Staples API" and dumped 8 questions as plain text. | Disable the composer (or queue the message) until setup state is `ready`; verify the tool-injection race server-side; never let the Assistant name tools or APIs in user-facing text. |
| 2 | A real account, plan and billing layer | Critical | XL | Everyone | Platform | Spend shows "$4.02 of $60 hosted limit" with no way to buy more; caps are env vars; no Stripe, no plan tiers, no invoices. | Plans (trial / starter / pro), card on file, usage meter with upgrade, per-company cap editable within plan, receipts. Prerequisite for any paid launch. |
| 3 | Rebrand away from Paperclip | Critical | M | Everyone | Copy | "Sign in to Paperclip", Paperclip lockup, tab titles, "Share feedback" to paperclip.ing, "Paperclip Labs" data-sharing, "Use your Paperclip organization from Codex…". 17 UI files reference it. | Product name, logo, favicon, titles, feedback URL, legal copy, server-side strings and email sender. |
| 4 | Sign-up and first screen that explain the product | Critical | M | Every new user | Flow | Sign-up copy: "Create an account for this instance. Email confirmation is not required in v1." Then a bare "Name your company" / "Acme Inc." page. No terms or privacy links. | One-line value prop plus three example businesses on sign-up; "What's your business called?" with "you can change this later"; terms and privacy links; email verification on hosted. |
| 5 | Interview opening written for business starters | High | S | Every new company | Copy | "What do you want to build?" with "A landing page for my idea", "An assistant for my inbox". Interview round asked 8 questions at once. | "What business are you starting?" with examples (a dog-walking service, a candle shop, a newsletter). Cap rounds at 3 or 4 questions, always via the question card with defaults. |
| 6 | Curate the Connectors page | High | M | Most | Flow | 60+ flat alphabetical entries incl. Amazon Bedrock, Chat Completions API, Messages API, Local endpoint, "provider-hosted MCP server" copy; "Couldn't load your connection status" error at the top; "Assistant Connection (MCP)" first. | "Needed by your team" section first with plain descriptions; model providers and raw API connectors under Advanced; fix the status error (401 on `/mcp/connections` in local mode). |
| 7 | Jargon sweep of default views | High | M | Everyone | Copy | "Run with provider trace", "Set as my primary", "From template: Researcher v1.2.0", model id `claude-opus-5-5`, skills chips "paperclip / complain / suggestion-box", "Latest Run · 252ed8a5", "Audit", "BO" avatar, "editable markdown", "Message the agent — describe what you want done…". | Extend the Phase 9 banned-terms test to all default surfaces; plain labels; hide ids, hashes and versions behind Advanced. |
| 8 | Costs page for owners, not engineers | High | M | Most | Flow | "API SPEND", tokens in/out, "cached", "Finance ledger", "invoice-authoritative", "Unattributed", Billers tab. | Default view: this month vs plan, per-agent spend, projected month end, "raise limit". Keep the ledger under Advanced. |
| 9 | Split company settings from instance admin | High | M | Most | Flow | Company settings shows Interaction governance table, Decision model, Bootstrap status, Backup retention, "remove the feedbackDataSharingPreference key from instance_settings.general JSON row". | Company page: name, logo, approvals default, budget, members, export, archive. Admin page: everything else, hidden unless instance admin. |
| 10 | Notify people outside the app | High | L | Everyone | Feature | No email or push code in the server. "Needs you" only appears if the person opens Home. | Email when something needs you (approval, question, blocked, budget) and a weekly digest; one-click actions from the email. Needs an email provider in the hosted stack. |
| 11 | Readable weekly update | High | S | Everyone | Bug | Card flattens markdown: "What shipped, The team is set up…, No tasks have finished yet., Blocked and what I need from you,". "Read" opens a task page (LAN-6). | Render the first section as formatted text; open the update in a document view, not the task thread. |
| 12 | Reveal surfaces gradually | High | S | Every new company | Flow | Right after the plan, 7 "new" badges appear at once (Chat, Routines, What we've made, Skills, Connectors, Company brief, Costs) because templates seed routines and skills. | Seeded items do not count toward reveal; batch reveals into one "your workspace grew" note; keep Skills and Connectors hidden until an agent asks. |
| 13 | First win before first vendor sign-up | High | M | Most | Flow | After the plan, the top "Needs you" item is "Connect Resend" with no explanation of what Resend, beehiiv or Klaviyo are; the Newsletter editor cannot do anything until then. | Sequence plans so an agent that "works right away" delivers first; explain the vendor choice in a comparison card with a recommended default and what it costs. |
| 14 | Hide Skills and fix path leaks | High | S | Most | Bug | Skills page shows `/Users/kelliott/Metaplex/staples/tmp/…` paths and internal skill names. | Advanced-only surface; never show filesystem paths; display names for skills. |
| 15 | Tasks list in plain words | Medium | M | Most | Flow | Unlabeled status icons, LAN-2 ids, unlabeled toolbar icons, "New Task". | Status words, group by "waiting on you / agents working / done", ids behind Advanced, tooltips on toolbar. |
| 16 | Question card controls | Medium | S | Most | Flow | "1 of 2" paging plus "Accept recommendations" and "Next" side by side; unclear whether Accept answers all pages; buttons wrap on phone. | One primary action per step; "Accept all N recommendations" label; stack buttons at phone width. |
| 17 | Getting-started checklist on Home | Medium | M | Every new company | Feature | After the plan, Home has no guidance; the user must infer the next step from "Needs you". | Checklist: answer the first question, connect a service, approve the first output, read the first report. Disappears when done. |
| 18 | Agent page for owners | Medium | M | Most | Flow | Leads with "Latest Run" and a hash, Setup (Runs on / Model), skills chips, Audit tabs, "No capability summary has been added." | Lead with what it does, what it is waiting on, what it made, its schedule, its budget. Runs and configuration under Advanced. |
| 19 | Stage 0 empty screen | Medium | S | Every new company | Copy | 80% empty page with one bubble and three chips. | Add what happens next (interview, plan, you approve, agents work), a trust note (agents ask before anything public), and example businesses. |
| 20 | Capture country and time zone in the interview | Medium | S | Every new company | Flow | Researcher "assumed the US"; weekly update noted an unknown time zone. | Ask once in round one or read from the browser; store on the company. |
| 21 | Undo a plan | Medium | M | Some | Feature | After "Create plan", hires and the budget raise cannot be reversed in one step. | "Undo this plan" for 24 hours: pause and remove hires, revert the cap, archive tasks. |
| 22 | Inbox duplicates Home | Medium | S | Most | Flow | Inbox shows a badge for items already on Home's "Needs you". | Only reveal Inbox when it has items not on Home (the registry intends this); otherwise rename it to Activity. |
| 23 | Help and support entry | Medium | S | Everyone | Feature | Only "Share feedback" in the sidebar footer. | "Help" with short guides and a support contact; the Assistant answers "how do I" questions with links to those guides. |
| 24 | Data export and account deletion | Medium | M | Some | Platform | Company export exists; no account deletion or data-request path. | Self-serve delete account and company, with the legal basis for hosted. |
| 25 | Phone polish | Low | S | Some | Flow | Bottom nav and Home work; cards wrap actions awkwardly; long task titles truncate without tooltip. | Stack action rows under 400px; sheet for long titles. |

## Suggested order

1. Items 1, 11, 12, 14, 5 (quick, every new user hits them).
2. Items 3, 4, 7, 6, 9, 8 (the "it looks like a product" pass).
3. Items 13, 17, 16, 18, 19, 20 (first week legibility).
4. Items 2, 10, 24 (platform work needed to charge money).
5. Items 15, 21, 22, 23, 25.

## Not covered

- Root cause of item 1 was not diagnosed; the symptom was reproduced once.
- The throwaway company "UX Review Bakery" remains in `tmp/staples-hosted2`.
- Authenticated-mode sign-up was read from code, not exercised live.
