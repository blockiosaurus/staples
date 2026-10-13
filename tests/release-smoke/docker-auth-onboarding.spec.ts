import { expect, test, type Page } from "@playwright/test";

const ADMIN_EMAIL =
  process.env.PAPERCLIP_RELEASE_SMOKE_EMAIL ??
  process.env.SMOKE_ADMIN_EMAIL ??
  "smoke-admin@paperclip.local";
const ADMIN_PASSWORD =
  process.env.PAPERCLIP_RELEASE_SMOKE_PASSWORD ??
  process.env.SMOKE_ADMIN_PASSWORD ??
  "paperclip-smoke-password";

const COMPANY_NAME = `Release-Smoke-${Date.now()}`;
// ASSISTANT_OPENING_MESSAGE in ui/src/staples/assistant/AssistantOpening.tsx.
const OPENING_QUESTION = "What do you want to build?";

async function signIn(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/auth/);

  await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();

  await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
}

async function getJson<T>(page: Page, url: string): Promise<T> {
  const response = await page.request.get(url);
  expect(response.ok()).toBe(true);
  return (await response.json()) as T;
}

test.describe("Docker authenticated onboarding smoke", () => {
  test("logs in, creates a company at /start, and lands in the Assistant", async ({
    page,
  }) => {
    await signIn(page);

    const baseUrl = new URL(page.url()).origin;

    // A board with no company routes sign-in straight to /start — the
    // first-run experience this suite exists to guard. Asserted only when the
    // instance really is company-less, because a retry (or a re-used smoke
    // container) runs against one that is not.
    const companiesBefore = await getJson<Array<{ id: string }>>(
      page,
      `${baseUrl}/api/companies`
    );
    if (companiesBefore.length === 0) {
      await expect(page).toHaveURL(/\/start$/, { timeout: 20_000 });
    }

    // /start asks for the company name only. Navigating explicitly keeps the
    // spec re-runnable against an instance that already holds a company.
    await page.goto("/start");
    const nameField = page.getByLabel("Company name");
    await expect(nameField).toBeVisible({ timeout: 20_000 });
    await nameField.fill(COMPANY_NAME);
    await page.getByRole("button", { name: "Create", exact: true }).click();

    // Creating the company drops the person into stage 0: the full-screen
    // Assistant conversation for the new company.
    await expect(page).toHaveURL(/\/[A-Z0-9]+\/assistant$/, { timeout: 30_000 });

    const companies = await getJson<
      Array<{ id: string; name: string; issuePrefix: string }>
    >(page, `${baseUrl}/api/companies`);
    const company = companies.find((entry) => entry.name === COMPANY_NAME);
    expect(company).toBeTruthy();
    expect(new URL(page.url()).pathname).toBe(
      `/${company!.issuePrefix}/assistant`
    );

    // The opening bubble is rendered by the client for an empty conversation,
    // without a model call.
    await expect(page.getByTestId("assistant-opening")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByTestId("assistant-opening").getByText(OPENING_QUESTION)
    ).toBeVisible();

    // A fresh instance has no model connected for the Assistant yet, so the
    // inline setup card takes the composer's place.
    await expect(page.getByTestId("assistant-setup-card")).toBeVisible({
      timeout: 30_000,
    });

    // Stage 0: the company starts with no staff agents (the Assistant is
    // hidden from agent lists).
    const agents = await getJson<Array<{ id: string }>>(
      page,
      `${baseUrl}/api/companies/${company!.id}/agents`
    );
    expect(agents).toEqual([]);
  });
});
