import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { COMPANY_BRIEF_MAX_CHARS, COMPANY_BRIEF_WAKE_EXCERPT_CHARS, type CompanyBrief } from "@paperclipai/shared";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { ApiError } from "@/api/client";
import { companyBriefApi } from "@/api/companyBrief";
import { queryKeys } from "@/lib/queryKeys";
import { relativeTime } from "@/lib/utils";

function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "Someone else changed the brief while you were editing. Your text is still here; reload to see their version, then reapply your change.";
  }
  if (error instanceof ApiError && error.status === 403) {
    return "You have view-only access to this company, so you can't edit the brief.";
  }
  return error instanceof Error ? error.message : "The brief could not be saved.";
}

/** `/:prefix/company/brief`: the company brief every agent reads on wake. */
export function CompanyBriefPage() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";

  useEffect(() => {
    setBreadcrumbs([{ label: "Company brief" }]);
  }, [setBreadcrumbs]);

  const briefQuery = useQuery({
    queryKey: queryKeys.companyBrief(companyId),
    queryFn: async () => (await companyBriefApi.get(companyId)) ?? null,
    enabled: Boolean(selectedCompanyId),
  });
  const brief = briefQuery.data ?? null;

  // The revision the draft was based on; null until the first load or for a new brief.
  const [base, setBase] = useState<CompanyBrief | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    if (briefQuery.isSuccess && draft === null) {
      setBase(brief);
      setDraft(brief?.body ?? "");
    }
  }, [brief, briefQuery.isSuccess, draft]);

  const save = useMutation({
    mutationFn: (body: string) =>
      companyBriefApi.update(companyId, { body, ...(base?.revisionId ? { baseRevisionId: base.revisionId } : {}) }),
    onSuccess: (saved) => {
      setBase(saved);
      setDraft(saved.body);
      queryClient.setQueryData(queryKeys.companyBrief(companyId), saved);
      void queryClient.invalidateQueries({ queryKey: queryKeys.signals(companyId) });
    },
  });

  const reload = async () => {
    const result = await briefQuery.refetch();
    const latest = result.data ?? null;
    setBase(latest);
    setDraft(latest?.body ?? "");
    save.reset();
  };

  if (briefQuery.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
        <p className="font-medium text-foreground">The company brief couldn't be loaded.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void briefQuery.refetch()}>
          <RotateCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    );
  }
  if (draft === null) {
    return <p className="p-4 text-sm text-muted-foreground">Loading company brief…</p>;
  }

  const dirty = draft !== (base?.body ?? "");
  const tooLong = draft.length > COMPANY_BRIEF_MAX_CHARS;
  const conflict = save.error instanceof ApiError && save.error.status === 409;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-foreground">Company brief</h1>
        <p className="text-sm text-muted-foreground">
          Your mission, glossary and key decisions. Every agent reads the first{" "}
          {COMPANY_BRIEF_WAKE_EXCERPT_CHARS.toLocaleString()} characters each time it starts work, so keep the most
          important context at the top. The Assistant can update it for you too.
        </p>
      </div>

      <div className="rounded-md border border-border">
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          ariaLabel="Company brief"
          placeholder="What the company does and for whom, the words it uses, and the decisions agents should follow."
          bordered={false}
          className="bg-transparent"
          contentClassName="min-h-(--sz-220px) text-sm leading-7"
          onSubmit={() => {
            if (dirty && !tooLong && !save.isPending) save.mutate(draft);
          }}
        />
      </div>

      {save.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span>{saveErrorMessage(save.error)}</span>
          {conflict ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
              <RotateCw className="h-3.5 w-3.5" />
              Reload
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {base
            ? `Revision ${base.revisionNumber} · updated ${relativeTime(base.updatedAt)}`
            : "No brief yet"}
          {" · "}
          <span className={tooLong ? "text-destructive" : undefined}>
            {draft.length.toLocaleString()} / {COMPANY_BRIEF_MAX_CHARS.toLocaleString()} characters
          </span>
        </span>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || tooLong || save.isPending}
          onClick={() => save.mutate(draft)}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
