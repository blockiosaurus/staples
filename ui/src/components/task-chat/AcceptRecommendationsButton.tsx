import { useId } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export const MISSING_RECOMMENDATION_REASON = "Some questions have no recommendation";

/**
 * Primary action that fills every untouched question with its recommendation
 * and submits. When a required question has neither a recommendation nor an
 * answer it is disabled, and the reason is both a tooltip and the button's
 * accessible description.
 */
export function AcceptRecommendationsButton({
  disabled,
  missingRecommendation,
  onClick,
}: {
  disabled: boolean;
  missingRecommendation: boolean;
  onClick: () => void;
}) {
  const reasonId = useId();
  const button = (
    <Button
      type="button"
      size="sm"
      disabled={disabled || missingRecommendation}
      aria-describedby={missingRecommendation ? reasonId : undefined}
      onClick={onClick}
    >
      Accept recommendations
    </Button>
  );
  if (!missingRecommendation) return button;
  return (
    // Local provider: the form also renders outside the app shell (tests,
    // embeds). Nested providers are harmless.
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A disabled button gets no pointer events; the wrapper carries the hover. */}
          <span tabIndex={0} className="inline-flex">
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent>{MISSING_RECOMMENDATION_REASON}</TooltipContent>
      </Tooltip>
      <span id={reasonId} className="sr-only">
        {MISSING_RECOMMENDATION_REASON}
      </span>
    </TooltipProvider>
  );
}
