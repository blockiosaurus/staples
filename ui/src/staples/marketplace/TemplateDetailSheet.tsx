import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentTemplateDetail, PaperclipQuestionSetQuestion } from "@paperclipai/shared";
import { RotateCw, UserPlus } from "lucide-react";
import { agentTemplatesApi } from "@/api/agentTemplates";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { queryKeys } from "@/lib/queryKeys";
import { useAskAssistant } from "@/staples/assistant/AssistantProvider";
import { assistantUnavailableNotice } from "@/staples/assistant/unavailableNotice";
import { describeRoutineSchedule } from "./schedule";
import { appChoices, budgetText, templateIcon } from "./templateText";

/** Shown when the Assistant can't take the hand-off (Home's notice; nothing waits in a composer here). */
export const HIRE_UNAVAILABLE_NOTICE = assistantUnavailableNotice("try again in a moment, or build your own agent.");

/**
 * The description without a leading H1 that repeats the template name (the
 * sheet header already shows it). Other leading headings are kept.
 */
export function descriptionWithoutTitle(description: string, name: string): string {
  const match = description.match(/^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/);
  if (!match || match[1]!.trim().toLowerCase() !== name.trim().toLowerCase()) return description;
  return description.slice(match[0].length).replace(/^\s+/, "");
}

/** The hand-off message: the Assistant finds the template, asks the setup questions and proposes the hire. */
export function hireMessage(name: string): string {
  return `Set up ${name}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function QuestionPreview({ question }: { question: PaperclipQuestionSetQuestion }) {
  const options = question.options ?? [];
  return (
    <li className="flex flex-col gap-1">
      <span className="text-sm text-foreground">{question.prompt}</span>
      {question.answerMode === "text" ? (
        question.initialText ? (
          <span className="text-xs text-muted-foreground">Suggested: {question.initialText}</span>
        ) : null
      ) : (
        <ul className="flex flex-wrap gap-1">
          {options.map((option) => (
            <li
              key={option.id}
              className={
                option.recommended
                  ? "rounded-md border border-border bg-muted px-2 py-0.5 text-xs text-foreground"
                  : "rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground"
              }
            >
              {option.label}
              {option.recommended ? <span className="sr-only"> (recommended)</span> : null}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function DetailBody({ detail }: { detail: AgentTemplateDetail }) {
  const budget = budgetText(detail.defaultBudgetMonthlyCents);
  const description = descriptionWithoutTitle(detail.description, detail.name);
  return (
    <div className="flex flex-col gap-6">
      {description.trim() ? (
        <MarkdownBody softBreaks={false} linkIssueReferences={false}>
          {description}
        </MarkdownBody>
      ) : null}

      {detail.routines.length > 0 ? (
        <Section title="Recurring work">
          <ul className="flex flex-col gap-1">
            {detail.routines.map((routine) => (
              <li key={routine.title} className="flex flex-col">
                <span className="text-sm text-foreground">{routine.title}</span>
                <span className="text-xs text-muted-foreground">{describeRoutineSchedule(routine)}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Services and access">
        <ul className="flex flex-col gap-2">
          {detail.needs.length === 0 ? (
            <li className="text-sm text-muted-foreground">Works right away — no apps to connect.</li>
          ) : (
            detail.needs.map((need) => (
              <li key={need.capability} className="flex flex-col">
                <span className="text-sm text-foreground">
                  {appChoices(need.anyOf)}
                  {need.optional ? <span className="text-muted-foreground"> (optional)</span> : null}
                </span>
                <span className="text-xs text-muted-foreground">{need.why}</span>
              </li>
            ))
          )}
          {detail.readOnly ? (
            <li className="text-sm text-foreground">Read-only: it never changes anything in your apps.</li>
          ) : detail.asksBefore.length > 0 ? (
            <li className="flex flex-col">
              <span className="text-sm text-foreground">Asks you before it acts</span>
              <span className="text-xs text-muted-foreground">{detail.asksBefore.join(", ")}</span>
            </li>
          ) : null}
          {budget ? (
            <li className="flex flex-col">
              <span className="text-sm text-foreground">Budget</span>
              <span className="text-xs text-muted-foreground">Starts at {budget}</span>
            </li>
          ) : null}
        </ul>
      </Section>

      {detail.setupQuestions.length > 0 ? (
        <Section title="The Assistant will ask">
          <ul className="flex flex-col gap-3" aria-label="Setup questions">
            {detail.setupQuestions.map((question) => (
              <QuestionPreview key={question.id} question={question} />
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

/** A template's full description, routines, access and setup questions, with Hire handing off to the Assistant. */
export function TemplateDetailSheet({
  companyId,
  slug,
  onClose,
}: {
  companyId: string;
  slug: string | null;
  onClose: () => void;
}) {
  const askAssistant = useAskAssistant();
  const [unavailable, setUnavailable] = useState(false);
  const detailQuery = useQuery({
    queryKey: queryKeys.agentTemplates.detail(companyId, slug ?? ""),
    queryFn: () => agentTemplatesApi.get(companyId, slug!),
    enabled: Boolean(companyId && slug),
  });
  const detail = detailQuery.data;
  const Icon = detail ? templateIcon(detail.icon) : UserPlus;

  const hire = () => {
    if (!detail) return;
    if (askAssistant({ text: hireMessage(detail.name), send: true })) {
      setUnavailable(false);
      onClose();
    } else {
      setUnavailable(true);
    }
  };

  return (
    <Sheet
      open={slug !== null}
      onOpenChange={(open) => {
        if (!open) {
          setUnavailable(false);
          onClose();
        }
      }}
    >
      <SheetContent className="w-full gap-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border">
          <div className="flex items-start gap-3 pr-6">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
              <Icon className="size-4" aria-hidden="true" />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <SheetTitle>{detail?.name ?? "Agent"}</SheetTitle>
              <SheetDescription>{detail?.tagline ?? "Loading…"}</SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4">
          {detailQuery.isError ? (
            <div role="alert" className="flex flex-col items-start gap-2 text-sm">
              <p className="text-foreground">This agent couldn't be loaded.</p>
              <p className="text-muted-foreground">
                {detailQuery.error instanceof Error ? detailQuery.error.message : "Try again in a moment."}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void detailQuery.refetch()}>
                <RotateCw className="size-3.5" aria-hidden="true" />
                Retry
              </Button>
            </div>
          ) : detail ? (
            <DetailBody detail={detail} />
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
        </div>

        <SheetFooter className="border-t border-border">
          {unavailable ? (
            <p role="alert" className="text-sm text-destructive">
              {HIRE_UNAVAILABLE_NOTICE}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">The Assistant sets it up with you.</span>
            <Button type="button" size="sm" disabled={!detail} onClick={hire}>
              <UserPlus aria-hidden="true" />
              Hire
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
