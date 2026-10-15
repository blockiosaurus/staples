import { describe, expect, it } from "vitest";
import { lintSvg } from "./lint.js";
const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>x</title><circle cx="32" cy="32" r="20" fill="#000"/></svg>';
describe("lintSvg", () => {
  it("accepts a plain mark", () => { expect(lintSvg(ok)).toEqual({ ok: true, errors: [] }); });
  it("rejects text, script, foreignObject, filters and external references", () => {
    for (const bad of ["<text x='1' y='1'>a</text>", "<script>1</script>", "<foreignObject/>", "<filter id='f'/>", "<image href='http://x/y.png'/>"]) {
      const r = lintSvg(ok.replace("</svg>", `${bad}</svg>`));
      expect(r.ok).toBe(false);
    }
  });
  it("rejects a missing viewBox and shapes outside the box", () => {
    expect(lintSvg(ok.replace(' viewBox="0 0 64 64"', "")).ok).toBe(false);
    expect(lintSvg(ok.replace('r="20"', 'r="40"')).ok).toBe(false);
  });
  it("rejects malformed XML", () => { expect(lintSvg("<svg viewBox='0 0 1 1'><circle").ok).toBe(false); });
  it("rejects on* handlers and href / xlink:href", () => {
    for (const attr of ["onload='x()'", "onclick='x()'", "href='#a'", "xlink:href='#a'"]) {
      expect(lintSvg(ok.replace("<circle", `<circle ${attr}`)).ok, attr).toBe(false);
    }
  });
  it("accepts a rect with rx", () => {
    expect(lintSvg(ok.replace("</svg>", '<rect x="4" y="4" width="56" height="56" rx="12"/></svg>')).ok).toBe(true);
  });
});
