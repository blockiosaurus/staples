import { optimize, type CustomPlugin } from "svgo";

export interface LintResult {
  ok: boolean;
  errors: string[];
}

const ALLOWED = new Set(["svg", "title", "g", "path", "circle", "rect", "polygon", "line", "ellipse", "defs", "clipPath"]);
const TOLERANCE = 0.5;

const num = (v: string | undefined, fallback = 0): number => {
  const x = v === undefined ? NaN : Number.parseFloat(v);
  return Number.isFinite(x) ? x : fallback;
};

type Box = { minX: number; minY: number; maxX: number; maxY: number };

function bboxOf(name: string, a: Record<string, string>): Box | null {
  switch (name) {
    case "circle": {
      const cx = num(a.cx), cy = num(a.cy), r = num(a.r);
      return { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
    }
    case "ellipse": {
      const cx = num(a.cx), cy = num(a.cy), rx = num(a.rx), ry = num(a.ry);
      return { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry };
    }
    case "rect": {
      const x = num(a.x), y = num(a.y);
      return { minX: x, minY: y, maxX: x + num(a.width), maxY: y + num(a.height) };
    }
    case "line": {
      const x1 = num(a.x1), y1 = num(a.y1), x2 = num(a.x2), y2 = num(a.y2);
      return { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) };
    }
    case "polygon": {
      const nums = (a.points ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
      if (nums.length < 2 || nums.some((v) => !Number.isFinite(v))) return null;
      const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
      return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
    }
    default:
      return null;
  }
}

/**
 * Structural lint for generated SVG: allow-listed elements only, no scripts, text,
 * filters, event handlers or hrefs, a required viewBox, and primitive shapes kept inside
 * the viewBox. Paths and transforms are not measured (outlined text lives in transformed groups).
 */
export function lintSvg(svg: string): LintResult {
  const errors: string[] = [];
  let viewBox: number[] | null = null;
  let sawRoot = false;
  const shapes: Array<{ name: string; box: Box }> = [];

  const plugin: CustomPlugin = {
    name: "brand-kit-lint",
    fn: () => ({
      element: {
        enter(node, parent) {
          const name = node.name;
          const isRoot = parent.type === "root";
          if (isRoot) {
            sawRoot = true;
            if (name !== "svg") errors.push(`root element must be <svg>, found <${name}>`);
            const vb = node.attributes.viewBox;
            if (!vb) errors.push("missing viewBox on root <svg>");
            else {
              const parts = vb.trim().split(/[\s,]+/).map(Number);
              if (parts.length === 4 && parts.every(Number.isFinite)) viewBox = parts;
              else errors.push(`invalid viewBox "${vb}"`);
            }
          }
          if (!ALLOWED.has(name)) errors.push(`disallowed element <${name}>`);
          for (const attr of Object.keys(node.attributes)) {
            const lower = attr.toLowerCase();
            if (lower.startsWith("on")) errors.push(`disallowed attribute ${attr} on <${name}>`);
            if (lower === "href" || lower === "xlink:href") errors.push(`disallowed attribute ${attr} on <${name}>`);
          }
          const box = bboxOf(name, node.attributes);
          if (box) shapes.push({ name, box });
        },
      },
    }),
  };

  try {
    optimize(svg, { plugins: [plugin], js2svg: { pretty: false } });
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { ok: false, errors: [`malformed SVG: ${msg}`] };
  }
  if (!sawRoot) errors.push("malformed SVG: no root element");

  const vb = viewBox as number[] | null;
  if (vb) {
    const [vx, vy, vw, vh] = vb as [number, number, number, number];
    for (const { name, box } of shapes) {
      if (box.minX < vx - TOLERANCE || box.minY < vy - TOLERANCE || box.maxX > vx + vw + TOLERANCE || box.maxY > vy + vh + TOLERANCE) {
        errors.push(`<${name}> extends outside the viewBox`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
