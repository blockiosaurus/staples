import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

export const ASSISTANT_OPENING_MESSAGE = "Hi — I'm your Assistant. What do you want to build?";
export const ASSISTANT_OPENING_SUGGESTIONS = [
  "A marketing team for my product",
  "Research and write a weekly newsletter",
  "Triage and fix bugs in my repo",
] as const;

/**
 * The Assistant's opening bubble, rendered by the client while the
 * conversation is empty (it is never stored as a message). Each suggestion
 * fills the composer; nothing is sent until the person sends it.
 */
export function AssistantOpening({
  onSuggestion,
  suggestionsDisabled = false,
}: {
  onSuggestion: (text: string) => void;
  suggestionsDisabled?: boolean;
}) {
  return (
    <div
      data-testid="assistant-opening"
      className="mx-auto flex w-full max-w-(--tc-shell-max-w) flex-col gap-3 px-4 py-6 md:px-0"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Sparkles className="size-4" aria-hidden="true" />
        </span>
        <p className="rounded-2xl rounded-tl-sm bg-muted px-4 py-2.5 text-sm text-foreground">{ASSISTANT_OPENING_MESSAGE}</p>
      </div>
      <div className="flex flex-wrap gap-2 pl-9.5" aria-label="Suggestions">
        {ASSISTANT_OPENING_SUGGESTIONS.map((suggestion) => (
          <Button
            key={suggestion}
            type="button"
            variant="outline"
            size="sm"
            className="h-auto rounded-full px-3 py-1.5 text-left font-normal whitespace-normal"
            disabled={suggestionsDisabled}
            onClick={() => onSuggestion(suggestion)}
          >
            {suggestion}
          </Button>
        ))}
      </div>
    </div>
  );
}
