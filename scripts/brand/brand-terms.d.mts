export const SWEEP_ROOTS: string[];
export const SWEEP_EXTENSIONS: Set<string>;
export const SKIP_DIR_NAMES: Set<string>;
export const KEEP_PHRASES: string[];
export function rewriteText(text: string): string;
export function findBrandMentions(source: string, ext: string): Array<{ line: number; text: string }>;
export function rewriteBrand(source: string, ext: string): string;
export function shouldSweepFile(filePath: string): boolean;
