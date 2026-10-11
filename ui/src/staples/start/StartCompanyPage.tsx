import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@/lib/router";
import { companiesApi } from "@/api/companies";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PaperclipLoading } from "@/components/AnimatedPaperclipIcon";
import { useCompany } from "@/context/CompanyContext";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { cloudStackCreateUrl } from "@/lib/cloudLinks";
import { navigateTopLevel } from "@/lib/browserNavigation";
import { queryKeys } from "@/lib/queryKeys";

/**
 * `/start`: the one-field way into a new company. Creating it drops the user
 * into stage 0, the full-screen Assistant conversation, which does the rest of
 * the setup. A Cloud-managed stack never creates in-app (POST /companies is a
 * 403 floor there), so it goes to its existing company or out to Cloud.
 */
export function StartCompanyPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { companies, selectedCompany, loading, setSelectedCompanyId } = useCompany();
  const cloudInstance = useCloudInstance();
  const createStackUrl = cloudStackCreateUrl(cloudInstance?.cloudBaseUrl ?? null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) return <PaperclipLoading />;

  if (cloudInstance) {
    const existing = selectedCompany ?? companies[0] ?? null;
    if (existing) return <Navigate to={`/${existing.issuePrefix}/assistant`} replace />;
    return (
      <StartShell title="Create your company">
        {createStackUrl ? (
          <Button onClick={() => navigateTopLevel(createStackUrl)}>Create in Paperclip Cloud</Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            Companies are created in Paperclip Cloud. This instance can&apos;t reach it right now; try again from your Cloud portfolio.
          </p>
        )}
      </StartShell>
    );
  }

  const trimmed = name.trim();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      const company = await companiesApi.create({ name: trimmed });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      setSelectedCompanyId(company.id);
      navigate(`/${company.issuePrefix}/assistant`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create company");
      setCreating(false);
    }
  }

  return (
    <StartShell title="Name your company">
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="start-company-name">Company name</Label>
          <Input
            id="start-company-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Acme Inc."
            disabled={creating}
          />
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" disabled={!trimmed || creating}>
          {creating ? "Creating..." : "Create"}
        </Button>
      </form>
    </StartShell>
  );
}

function StartShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-md">
        <h1 className="mb-6 text-2xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}
