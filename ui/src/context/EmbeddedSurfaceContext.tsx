import { createContext, useContext } from "react";

/**
 * True inside a conversation surface rendered within another page (the
 * Assistant dock). Such a surface scrolls its own element, never the window,
 * and ignores the host page's URL hash.
 */
export const EmbeddedSurfaceContext = createContext(false);

export function useEmbeddedSurface(): boolean {
  return useContext(EmbeddedSurfaceContext);
}
