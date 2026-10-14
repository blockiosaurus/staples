import { LegalPage } from "./LegalPage";
import { PRODUCT_NAME } from "@/lib/branding";

export function TermsPage() {
  return (
    <LegalPage title="Terms of service" updated="October 14, 2026">
      <section>
        <h2>What {PRODUCT_NAME} is</h2>
        <p>{PRODUCT_NAME} lets you run a business with AI agents you direct. You stay in charge: agents ask before they do anything public or spend money beyond the limits you set.</p>
      </section>
      <section>
        <h2>Your account</h2>
        <p>You are responsible for what happens under your account and for keeping your password private. Tell us right away if you think someone else has used it.</p>
      </section>
      <section>
        <h2>Your content</h2>
        <p>What you and your agents create belongs to you. We use it only to run the service for you.</p>
      </section>
      <section>
        <h2>Fees and limits</h2>
        <p>Usage counts against the spending limits shown in Costs. We will not charge beyond a limit you have not raised.</p>
      </section>
      <section>
        <h2>Changes</h2>
        <p>We may update these terms. We will show the date of the latest change at the top of this page.</p>
      </section>
    </LegalPage>
  );
}
