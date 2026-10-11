import { BookOpen } from "lucide-react";
import { Link } from "@/lib/router";
import { AssistantConversation } from "./AssistantConversation";

/** `/:prefix/assistant`: the full-page Assistant conversation. */
export function AssistantPage() {
  return (
    <>
      <div className="flex items-center justify-end px-4 pt-2 text-sm">
        <Link
          to="/company/brief"
          className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
          Company brief
        </Link>
      </div>
      <AssistantConversation />
    </>
  );
}
