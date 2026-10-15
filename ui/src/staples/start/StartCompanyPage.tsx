import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@/lib/router";
import { companiesApi } from "@/api/companies";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { PaperclipLoading } from "@/components/AnimatedPaperclipIcon";
import { useCompany } from "@/context/CompanyContext";
import { useCanCreateCompany } from "@/hooks/useCanCreateCompany";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { cloudStackCreateUrl } from "@/lib/cloudLinks";
import { navigateTopLevel } from "@/lib/browserNavigation";
import { deriveWorkingName } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";

/**
 * `/start`: the one-field way into a new company. Creating it drops the user
 * into stage 0, the full-screen Assistant conversation, which does the rest of
 * the setup. People who already have a company get a way back. A Cloud-managed
 * stack never creates in-app (POST /companies is a 403 floor there), so it
 * explains that and links out to Cloud instead of redirecting silently.
 */
export function StartCompanyPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { companies, selectedCompany, loading, setSelectedCompanyId } = useCompany();
  const cloudInstance = useCloudInstance();
  const createStackUrl = cloudStackCreateUrl(cloudInstance?.cloudBaseUrl ?? null);
  const { canCreate, loaded: canCreateLoaded } = useCanCreateCompany();
  const [description, setDescription] = useState("");
  const [name, setName] = useState("");
  const [showName, setShowName] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading || (!cloudInstance && !canCreateLoaded)) return <PaperclipLoading />;

  const existing = selectedCompany ?? companies[0] ?? null;
  const backLink = existing ? (
    <Link to={`/${existing.issuePrefix}/assistant`} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
      Back to {existing.name}
    </Link>
  ) : null;

  if (cloudInstance) {
    return (
      <StartShell title={existing ? "New companies are created in Cloud" : "Create your company"} footer={backLink}>
        <p className="mb-4 text-sm text-muted-foreground">
          {existing
            ? "This stack is managed by Staples Cloud, so a new company is created there, not in this app."
            : "Companies on this stack are created in Staples Cloud."}
        </p>
        {createStackUrl ? (
          <Button onClick={() => navigateTopLevel(createStackUrl)}>Create in Staples Cloud</Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            This instance can&apos;t reach Staples Cloud right now; try again from your Cloud portfolio.
          </p>
        )}
      </StartShell>
    );
  }

  // Only admins create companies unless the instance turned on self-serve
  // (PAPERCLIP_SELF_SERVE_COMPANIES). Say so instead of a form that would 403.
  if (!canCreate) {
    return (
      <StartShell title={existing ? "Only an admin can create a company here" : "Ask the person who invited you for access"} footer={backLink}>
        <p className="text-sm text-muted-foreground">
          {existing
            ? "Ask an admin to create the company, or to add you to one."
            : "You're signed in, but this account isn't part of a company here yet. The person who invited you can add you."}
        </p>
      </StartShell>
    );
  }

  const trimmedDescription = description.trim();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!trimmedDescription || creating) return;
    setCreating(true);
    setError(null);
    try {
      const company = await companiesApi.create({
        name: name.trim() || deriveWorkingName(trimmedDescription),
        description: trimmedDescription,
        kickoff: true,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      // A self-serve creator's first company changes their board access.
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
      setSelectedCompanyId(company.id);
      navigate(`/${company.issuePrefix}/assistant`, {
        replace: true,
        state: { firstMessage: trimmedDescription },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create company");
      setCreating(false);
    }
  }

  return (
    <StartShell title="What business do you want to start?" footer={backLink}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Textarea
            id="start-company-description"
            aria-labelledby="start-title"
            aria-describedby="start-description-help"
            autoFocus
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="A candle shop in Austin that sells online and at markets"
            disabled={creating}
          />
          <p id="start-description-help" className="text-xs text-muted-foreground">One or two sentences is plenty. You can change everything later.</p>
        </div>
        <button
          type="button"
          className="text-sm text-muted-foreground underline"
          onClick={() => setShowName((shown) => !shown)}
        >
          Have a name already?
        </button>
        {showName ? (
          <div className="space-y-2">
            <Label htmlFor="start-company-name">Business name</Label>
            <Input
              id="start-company-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Lantern Candle Co"
              disabled={creating}
            />
          </div>
        ) : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" disabled={!trimmedDescription || creating}>
          {creating ? "Creating..." : "Create"}
        </Button>
      </form>
    </StartShell>
  );
}

function StartShell({ title, children, footer }: { title: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-md">
        <h1 id="start-title" className="mb-6 text-2xl font-semibold">{title}</h1>
        {children}
        {footer ? <div className="mt-6">{footer}</div> : null}
      </div>
    </main>
  );
}
