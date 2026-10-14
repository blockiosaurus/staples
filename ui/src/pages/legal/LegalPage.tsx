import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { ProductWordmark } from "@/components/ProductWordmark";
import { PRIVACY_PATH, TERMS_PATH } from "@/lib/branding";

/** Shared shell for the signed-out legal pages. Static copy only; no company context. */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <main className="min-h-dvh bg-background px-4 py-12 text-foreground">
      <div className="mx-auto w-full max-w-2xl space-y-8">
        <Link to="/auth" className="inline-flex" aria-label="Back to sign in">
          <ProductWordmark />
        </Link>
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-sm text-muted-foreground">Last updated {updated}</p>
          <p role="status" className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            Draft, not yet reviewed. This page is a placeholder until our terms are finalized.
          </p>
        </header>
        <div className="space-y-6 text-sm leading-relaxed [&_h2]:text-base [&_h2]:font-semibold">{children}</div>
        <footer className="flex flex-wrap gap-4 border-t border-border pt-6 text-sm text-muted-foreground">
          <Link to={TERMS_PATH} className="hover:text-foreground">Terms of service</Link>
          <Link to={PRIVACY_PATH} className="hover:text-foreground">Privacy policy</Link>
          <Link to="/auth" className="hover:text-foreground">Sign in</Link>
        </footer>
      </div>
    </main>
  );
}
