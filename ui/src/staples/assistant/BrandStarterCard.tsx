import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BrandStarterConcept } from "@paperclipai/shared";
import { X } from "lucide-react";
import { assetsApi } from "@/api/assets";
import { brandStarterApi } from "@/api/brand-starter";
import { companiesApi } from "@/api/companies";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";

const cardClass = "mx-auto w-full max-w-3xl rounded-lg border border-border bg-card p-3";

const STOPPED = ["cancelled", "blocked"];

function dismissKey(companyId: string) {
  return `staples.brandStarter.dismissed.${companyId}`;
}

function readDismissed(companyId: string): boolean {
  try {
    return localStorage.getItem(dismissKey(companyId)) === "1";
  } catch {
    return false;
  }
}

/**
 * Stage 0: the brand designer's name and logo ideas. Shows progress while the
 * designer works, then one tile per concept; "Use this" applies the concept's
 * logo (and its name, unless the person keeps their own).
 */
export function BrandStarterCard() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const [keepName, setKeepName] = useState(false);
  const [applyingIndex, setApplyingIndex] = useState<number | null>(null);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => (companyId ? readDismissed(companyId) : false));

  const { data } = useQuery({
    queryKey: queryKeys.brandStarter.status(companyId),
    queryFn: () => brandStarterApi.get(companyId),
    enabled: !!companyId && !dismissed,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d?.issue || STOPPED.includes(d.issue.status)) return false;
      return d.concepts.length ? false : 5_000;
    },
  });

  if (!companyId || !data?.issue || dismissed) return null;

  async function apply(concept: BrandStarterConcept) {
    setError(null);
    setApplyingIndex(concept.index);
    try {
      const res = await fetch(concept.markPath);
      if (!res.ok) throw new Error("load failed");
      const blob = await res.blob();
      const file = new File([blob], `concept-${concept.index}-mark.svg`, { type: "image/svg+xml" });
      const asset = await assetsApi.uploadCompanyLogo(companyId, file);
      await companiesApi.updateBranding(
        companyId,
        keepName ? { logoAssetId: asset.assetId } : { name: concept.name, logoAssetId: asset.assetId },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      setApplied(true);
    } catch (err) {
      console.warn("Brand starter apply failed", err);
      setError("Couldn't apply that idea. Try again.");
    } finally {
      setApplyingIndex(null);
    }
  }

  const artifactsHref = `/${selectedCompany?.issuePrefix ?? ""}/artifacts`;

  if (applied || selectedCompany?.logoAssetId) {
    return (
      <section aria-label="Brand starter" data-testid="brand-starter-card" className={cardClass}>
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-foreground">{applied ? "Applied" : "Brand applied"}</p>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss brand starter"
            title="Dismiss"
            onClick={() => {
              try {
                localStorage.setItem(dismissKey(companyId), "1");
              } catch {
                // storage unavailable; hide for this visit only
              }
              setDismissed(true);
            }}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <Link to={artifactsHref} className="text-sm font-medium text-foreground hover:underline">
          See what we've made
        </Link>
      </section>
    );
  }

  if (!data.concepts.length && STOPPED.includes(data.issue.status)) {
    return (
      <section aria-label="Brand starter" data-testid="brand-starter-card" className={cardClass}>
        <p className="text-sm text-muted-foreground">
          Your brand designer could not finish. You can add a logo later in Company settings.
        </p>
      </section>
    );
  }

  if (!data.concepts.length) {
    return (
      <section aria-label="Brand starter" data-testid="brand-starter-card" className={cardClass}>
        <p className="text-sm font-medium text-foreground">Your brand designer is working on name and logo ideas.</p>
        {data.latestNote ? <p className="text-sm text-muted-foreground">{data.latestNote}</p> : null}
      </section>
    );
  }

  return (
    <section aria-label="Brand starter" data-testid="brand-starter-card" className={`${cardClass} flex flex-col gap-3`}>
      <p className="text-sm font-medium text-foreground">Pick a name and logo to start with</p>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input type="checkbox" checked={keepName} onChange={(e) => setKeepName(e.target.checked)} />
        Keep my name
      </label>
      <div className="grid gap-3 sm:grid-cols-3" aria-busy={applyingIndex !== null}>
        {data.concepts.map((concept) => (
          <figure key={concept.index} className="flex flex-col gap-2 rounded-md border border-border p-2">
            <img
              src={concept.lockupPath}
              alt={`${concept.name} logo idea`}
              className="aspect-video w-full bg-accent/20 object-contain"
            />
            <figcaption className="text-sm font-medium text-foreground">{concept.name}</figcaption>
            <Button type="button" size="sm" aria-label={`Use ${concept.name}`} disabled={applyingIndex !== null} onClick={() => void apply(concept)}>
              Use this
            </Button>
          </figure>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
