import { LegalPage } from "./LegalPage";
import { PRODUCT_NAME } from "@/lib/branding";

export function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" updated="October 14, 2026">
      <section>
        <h2>What we collect</h2>
        <p>Your name, email address, and the content you and your agents create in {PRODUCT_NAME}.</p>
      </section>
      <section>
        <h2>How we use it</h2>
        <p>To run the service, to send you the updates you ask for, and to keep your account secure. We do not sell your data.</p>
      </section>
      <section>
        <h2>Services you connect</h2>
        <p>When you connect a service such as email or payments, agents use that access only for the work you assign. You can disconnect a service at any time from Connectors.</p>
      </section>
      <section>
        <h2>Your choices</h2>
        <p>You can export your company data from Settings. Contact us to delete your account.</p>
      </section>
    </LegalPage>
  );
}
