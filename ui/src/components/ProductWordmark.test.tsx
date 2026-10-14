// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ProductWordmark } from "./ProductWordmark";

function render(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  flushSync(() => createRoot(container).render(node));
  return container;
}

describe("ProductWordmark", () => {
  it("names the product for assistive tech and shows the wordmark text", () => {
    const container = render(<ProductWordmark />);
    const mark = container.querySelector('[role="img"]');
    expect(mark?.getAttribute("aria-label")).toBe("Staples");
    expect(container.textContent).toContain("Staples");
  });

  it("is hidden from assistive tech when decorative", () => {
    const container = render(<ProductWordmark decorative />);
    expect(container.querySelector('[role="img"]')).toBeNull();
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });
});
