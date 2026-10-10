import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronRight,
  Folder as FolderIcon,
  FolderPlus,
  Home,
  Plus,
  Search,
} from "lucide-react";
import type { FolderListItem, FolderListResult } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { FolderSwatch, type FolderSelection } from "./FolderControls";
import {
  buildSkillFolderTree,
  folderBreadcrumbTrail,
  isBundledFolder,
  isProjectsFolder,
  reservedRootLabel,
  skillFolderDisplayPath,
  skillFolderPathDisplayFallback,
  subtreeFolderIds,
  treeFromResult,
  type FolderTreeNode,
  type SkillFolderTreeModel,
} from "./skill-folder-tree";

export {
  buildSkillFolderTree,
  folderBreadcrumbTrail,
  isBundledFolder,
  isProjectsFolder,
  reservedRootLabel,
  skillFolderDisplayPath,
  skillFolderPathDisplayFallback,
  subtreeFolderIds,
  treeFromResult,
  type SkillFolderTreeModel,
};

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

export function FolderBreadcrumb({
  result,
  selection,
  onSelect,
}: {
  result: FolderListResult | null | undefined;
  selection: FolderSelection;
  onSelect: (selection: FolderSelection) => void;
}) {
  const model = useMemo(() => treeFromResult(result), [result]);
  const trail = selection === "all" || selection === "unfiled"
    ? []
    : folderBreadcrumbTrail(model, selection);

  return (
    <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
      <button
        type="button"
        onClick={() => onSelect("all")}
        className={cn(
          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-accent/40",
          selection === "all" ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        <Home className="h-3.5 w-3.5" />
        All skills
      </button>
      {selection === "unfiled" ? (
        <>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
          <span className="rounded px-1.5 py-0.5 font-medium text-foreground">Unfiled</span>
        </>
      ) : null}
      {trail.map((folder, index) => {
        const isLast = index === trail.length - 1;
        const label = index === 0 ? reservedRootLabel(folder) : folder.name;
        return (
          <span key={folder.id} className="inline-flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
            <button
              type="button"
              onClick={() => onSelect(folder.id)}
              className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-accent/40",
                isLast ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {folder.color ? <FolderSwatch color={folder.color} /> : null}
              {label}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Subfolder tiles (folder browser)
// ---------------------------------------------------------------------------

export function FolderTiles({
  result,
  selection,
  onOpen,
}: {
  result: FolderListResult | null | undefined;
  selection: FolderSelection;
  onOpen: (folderId: string) => void;
}) {
  const model = useMemo(() => treeFromResult(result), [result]);
  const children = useMemo<FolderTreeNode[]>(() => {
    if (selection === "unfiled") return [];
    if (selection === "all") return model.roots;
    return model.childrenById.get(selection) ?? [];
  }, [model, selection]);

  if (children.length === 0) return null;

  return (
    <div className="mb-4">
      <div className="mb-2 text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
        Folders
      </div>
      <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(11rem,1fr))]">
        {children.map((node) => (
          <button
            key={node.folder.id}
            type="button"
            onClick={() => onOpen(node.folder.id)}
            className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-foreground/30 hover:bg-accent/30"
          >
            {node.folder.systemKey && ["my", "projects", "bundled"].includes(node.folder.systemKey) ? (
              <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <FolderSwatch color={node.folder.color} className="h-3.5 w-3.5" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {reservedRootLabel(node.folder)}
            </span>
            <span className="text-xs text-muted-foreground">{node.folder.itemCount}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Move-to-folder dialog (tree picker + inline new folder + path preview)
// ---------------------------------------------------------------------------

export function MoveToFolderDialog({
  open,
  onOpenChange,
  result,
  title,
  subtitle,
  currentFolderId,
  pending = false,
  onMove,
  onCreateFolder,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: FolderListResult | null | undefined;
  title: string;
  subtitle?: string | null;
  currentFolderId: string | null | undefined;
  pending?: boolean;
  onMove: (folderId: string | null) => void;
  /** Create a folder under `parentId` (null = top level); resolve to the new id. */
  onCreateFolder: (parentId: string | null, name: string) => Promise<string | null>;
}) {
  const model = useMemo(() => treeFromResult(result), [result]);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  const [creatingParent, setCreatingParent] = useState<string | null | undefined>(undefined);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open) {
      setQuery("");
      setTarget(undefined);
      setCreatingParent(undefined);
      setNewName("");
    }
  }, [open]);

  const lowered = query.trim().toLowerCase();
  const matches = (folder: FolderListItem) =>
    !lowered || folder.name.toLowerCase().includes(lowered) || folder.path.toLowerCase().includes(lowered);

  // The selected destination (undefined = nothing picked yet).
  const chosen = target;
  const chosenFolder = typeof chosen === "string" ? model.byId.get(chosen) ?? null : null;
  const previewPath = chosen === undefined
    ? null
    : chosen === null
      ? "Unfiled"
      : chosenFolder?.path ?? null;

  async function submitNewFolder() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const id = await onCreateFolder(creatingParent ?? null, name);
      if (id) setTarget(id);
      setCreatingParent(undefined);
      setNewName("");
    } finally {
      setCreating(false);
    }
  }

  function renderNode(node: FolderTreeNode, depth: number): ReactNode {
    const { folder } = node;
    const bundled = isBundledFolder(folder);
    const selectable = !bundled;
    const isChosen = chosen === folder.id;
    const isCurrent = currentFolderId === folder.id;
    const nestable = selectable && !isProjectsFolder(folder) && folder.depth < 4;
    const visibleChildren = node.children;
    const selfMatches = matches(folder);
    // Keep a folder if it or any descendant matches the filter.
    const childMatches = subtreeMatches(node, matches);
    if (lowered && !selfMatches && !childMatches) return null;

    return (
      <div key={folder.id}>
        <div
          className={cn(
            "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
            selectable ? "cursor-pointer hover:bg-accent/40" : "cursor-not-allowed opacity-50",
            isChosen && "bg-accent/70",
          )}
          style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
          onClick={() => selectable && setTarget(folder.id)}
        >
          {folder.systemKey && ["my", "projects", "bundled"].includes(folder.systemKey) ? (
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <FolderSwatch color={folder.color} />
          )}
          <span className="min-w-0 flex-1 truncate">{reservedRootLabel(folder)}</span>
          {isCurrent ? <span className="text-xs text-muted-foreground">current</span> : null}
          {bundled ? <span className="text-xs text-muted-foreground">read-only</span> : null}
          {isChosen ? <Check className="h-3.5 w-3.5" /> : null}
          {nestable ? (
            <button
              type="button"
              title="New folder inside…"
              className="opacity-0 transition-opacity group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                setCreatingParent(folder.id);
                setNewName("");
              }}
            >
              <FolderPlus className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          ) : null}
        </div>
        {creatingParent === folder.id ? (
          <InlineNewFolder
            depth={depth + 1}
            value={newName}
            pending={creating}
            onChange={setNewName}
            onSubmit={submitNewFolder}
            onCancel={() => setCreatingParent(undefined)}
          />
        ) : null}
        {visibleChildren.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {subtitle ? <DialogDescription>{subtitle}</DialogDescription> : null}
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-md border border-border px-2.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search folders"
            className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="max-h-72 overflow-y-auto rounded-md border border-border p-1">
          <div
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/40",
              chosen === null && "bg-accent/70",
            )}
            onClick={() => setTarget(null)}
          >
            <FolderSwatch color={null} />
            <span className="min-w-0 flex-1 truncate">Unfiled</span>
            {currentFolderId == null ? <span className="text-xs text-muted-foreground">current</span> : null}
            {chosen === null ? <Check className="h-3.5 w-3.5" /> : null}
          </div>
          {model.roots.map((node) => renderNode(node, 0))}
          <div className="mt-1 border-t border-border pt-1">
            {creatingParent === null ? (
              <InlineNewFolder
                depth={0}
                value={newName}
                pending={creating}
                onChange={setNewName}
                onSubmit={submitNewFolder}
                onCancel={() => setCreatingParent(undefined)}
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setCreatingParent(null);
                  setNewName("");
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent/40 hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                New top-level folder…
              </button>
            )}
          </div>
        </div>

        <div className="min-h-5 text-xs text-muted-foreground">
          {previewPath ? (
            <span>
              Moving to <span className="font-mono text-foreground">{previewPath}</span>
            </span>
          ) : (
            <span>Pick a destination folder.</span>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending || chosen === undefined || chosen === currentFolderId}
            onClick={() => chosen !== undefined && onMove(chosen)}
          >
            {pending ? "Moving…" : "Move here"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function subtreeMatches(node: FolderTreeNode, matches: (folder: FolderListItem) => boolean): boolean {
  if (matches(node.folder)) return true;
  return node.children.some((child) => subtreeMatches(child, matches));
}

function InlineNewFolder({
  depth,
  value,
  pending,
  onChange,
  onSubmit,
  onCancel,
}: {
  depth: number;
  value: string;
  pending: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-2 py-1" style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}>
      <FolderPlus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Folder name"
        autoFocus
        className="h-7 flex-1 text-sm"
        onKeyDown={(event) => {
          if (event.key === "Enter") onSubmit();
          if (event.key === "Escape") onCancel();
        }}
      />
      <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
        Cancel
      </Button>
      <Button size="sm" onClick={onSubmit} disabled={pending || !value.trim()}>
        Add
      </Button>
    </div>
  );
}
