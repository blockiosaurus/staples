// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function TestHarness({
  onNewIssue,
  onSearch,
  onGoToInbox,
  onToggleAssistant,
}: {
  onNewIssue: () => void;
  onSearch?: () => void;
  onGoToInbox?: () => void;
  onToggleAssistant?: () => void;
}) {
  useKeyboardShortcuts({
    onNewIssue,
    onSearch,
    onGoToInbox,
    onToggleAssistant,
  });

  return <div>keyboard shortcuts test</div>;
}

describe("useKeyboardShortcuts", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("ignores events already claimed by another handler", () => {
    const root = createRoot(container);
    const onNewIssue = vi.fn();

    act(() => {
      root.render(<TestHarness onNewIssue={onNewIssue} />);
    });

    const event = new KeyboardEvent("keydown", {
      key: "c",
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    document.dispatchEvent(event);

    expect(onNewIssue).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("focuses the current page search target on slash", () => {
    const root = createRoot(container);
    const onSearch = vi.fn();
    const input = document.createElement("input");
    input.setAttribute("data-page-search-target", "true");
    vi.spyOn(input, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    document.body.appendChild(input);

    act(() => {
      root.render(<TestHarness onNewIssue={vi.fn()} onSearch={onSearch} />);
    });

    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "/",
      bubbles: true,
      cancelable: true,
    }));

    expect(document.activeElement).toBe(input);
    expect(onSearch).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    input.remove();
  });

  it("falls back to quick search when the page has no search target", () => {
    const root = createRoot(container);
    const onSearch = vi.fn();

    act(() => {
      root.render(<TestHarness onNewIssue={vi.fn()} onSearch={onSearch} />);
    });

    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "/",
      bubbles: true,
      cancelable: true,
    }));

    expect(onSearch).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("ignores bare shortcuts while a modal dialog is open", () => {
    const root = createRoot(container);
    const onNewIssue = vi.fn();
    const onSearch = vi.fn();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);

    act(() => {
      root.render(<TestHarness onNewIssue={onNewIssue} onSearch={onSearch} />);
    });

    for (const key of ["c", "/"]) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    }
    expect(onNewIssue).not.toHaveBeenCalled();
    expect(onSearch).not.toHaveBeenCalled();

    dialog.remove();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }));
    expect(onNewIssue).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("does not intercept the retired Cmd/Ctrl+B collapse shortcut", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<TestHarness onNewIssue={vi.fn()} />);
    });

    const metaEvent = new KeyboardEvent("keydown", {
      key: "b",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(metaEvent);
    expect(metaEvent.defaultPrevented).toBe(false);

    const ctrlEvent = new KeyboardEvent("keydown", {
      key: "b",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(ctrlEvent);
    expect(ctrlEvent.defaultPrevented).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  const pressKey = (key: string) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event;
  };

  it("navigates to the inbox on the g \u2192 i chord", () => {
    const root = createRoot(container);
    const onGoToInbox = vi.fn();
    const onNewIssue = vi.fn();

    act(() => {
      root.render(<TestHarness onNewIssue={onNewIssue} onGoToInbox={onGoToInbox} />);
    });

    // Bare "i" does nothing.
    pressKey("i");
    expect(onGoToInbox).not.toHaveBeenCalled();

    pressKey("g");
    const chordEvent = pressKey("i");
    expect(onGoToInbox).toHaveBeenCalledTimes(1);
    expect(chordEvent.defaultPrevented).toBe(true);

    // Chord disarms after firing.
    pressKey("i");
    expect(onGoToInbox).toHaveBeenCalledTimes(1);
    expect(onNewIssue).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("swallows armed chord keys instead of firing bare shortcuts", () => {
    const root = createRoot(container);
    const onGoToInbox = vi.fn();
    const onNewIssue = vi.fn();

    act(() => {
      root.render(<TestHarness onNewIssue={onNewIssue} onGoToInbox={onGoToInbox} />);
    });

    // g \u2192 c is the issue-detail focus-comment chord; globally it must not
    // open the new-issue dialog.
    pressKey("g");
    pressKey("c");
    expect(onNewIssue).not.toHaveBeenCalled();
    expect(onGoToInbox).not.toHaveBeenCalled();

    // Bare "c" still creates.
    pressKey("c");
    expect(onNewIssue).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });


  describe("Cmd/Ctrl+J Assistant toggle", () => {
    function renderWithToggle() {
      const root = createRoot(container);
      const onToggleAssistant = vi.fn();
      act(() => {
        root.render(<TestHarness onNewIssue={vi.fn()} onToggleAssistant={onToggleAssistant} />);
      });
      return { root, onToggleAssistant };
    }

    for (const modifier of ["metaKey", "ctrlKey"] as const) {
      it(`toggles with ${modifier} from a focused textarea and prevents the default`, () => {
        const { root, onToggleAssistant } = renderWithToggle();
        const textarea = document.createElement("textarea");
        document.body.appendChild(textarea);
        textarea.focus();
        const event = new KeyboardEvent("keydown", { key: "j", [modifier]: true, bubbles: true, cancelable: true });
        textarea.dispatchEvent(event);
        expect(onToggleAssistant).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
        textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "J", [modifier]: true, bubbles: true, cancelable: true }));
        expect(onToggleAssistant).toHaveBeenCalledTimes(2);
        textarea.remove();
        act(() => root.unmount());
      });
    }

    it("ignores bare j and other modifier combinations", () => {
      const { root, onToggleAssistant } = renderWithToggle();
      for (const init of [{}, { altKey: true, metaKey: true }, { shiftKey: true, ctrlKey: true }]) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", ...init, bubbles: true, cancelable: true }));
      }
      expect(onToggleAssistant).not.toHaveBeenCalled();
      act(() => root.unmount());
    });

    it("does nothing while a blocking modal dialog is open", () => {
      const { root, onToggleAssistant } = renderWithToggle();
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      document.body.appendChild(dialog);
      const event = new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      expect(onToggleAssistant).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
      dialog.remove();
      act(() => root.unmount());
    });
  });
});
