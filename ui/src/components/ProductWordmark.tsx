import { PRODUCT_NAME } from "@/lib/branding";
import { cn } from "@/lib/utils";

/**
 * The typographic product wordmark: a letter mark plus the product name.
 * Size it with a text class on `className`; the mark scales with the text.
 */
export function ProductWordmark({ className, decorative = false }: { className?: string; decorative?: boolean }) {
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : PRODUCT_NAME}
      aria-hidden={decorative ? true : undefined}
      className={cn("inline-flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground", className)}
    >
      <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-md bg-foreground text-sm font-bold text-background">
        {PRODUCT_NAME.charAt(0)}
      </span>
      <span>{PRODUCT_NAME}</span>
    </span>
  );
}
