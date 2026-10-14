import test from "node:test";
import assert from "node:assert/strict";
import { findBrandMentions, rewriteBrand, rewriteText } from "./brand-terms.mjs";

test("rewrites readable text only", () => {
  const src = `import { Paperclip } from "lucide-react";
import { PaperclipLoading } from "./x";
const a = "Sign in to Paperclip";
const b = \`Connect \${name} to Paperclip\`;
const c = <p>Welcome to Paperclip's board <Paperclip /></p>;
const d = { label: "Paperclip Labs", icon: Paperclip };
const e = "@paperclipai/shared"; const f = "paperclip_connection";
`;
  const out = rewriteBrand(src, ".tsx");
  assert.match(out, /Sign in to Staples/);
  assert.match(out, /Connect \$\{name\} to Staples/);
  assert.match(out, /Welcome to Staples' board <Paperclip \/>/);
  assert.match(out, /Paperclip Labs/);
  assert.match(out, /import \{ Paperclip \} from "lucide-react"/);
  assert.match(out, /PaperclipLoading/);
  assert.match(out, /icon: Paperclip/);
  assert.match(out, /@paperclipai\/shared/);
  assert.equal(findBrandMentions(out, ".tsx").length, 0);
});

test("reports remaining mentions with line numbers", () => {
  const src = `const x = 1;\nconst y = "Paperclip host";\n`;
  assert.deepEqual(findBrandMentions(src, ".ts"), [{ line: 2, text: 'const y = "Paperclip host";' }]);
});

test("markdown is plain text", () => {
  assert.equal(rewriteText("You are Paperclip's coach at Paperclip. Keep Paperclip Dot."), "You are Staples' coach at Staples. Keep Paperclip Dot.");
});

test("rewrites text inside exported declarations but not re-export sources", () => {
  const src = `export function A() { return <h1>This Paperclip rocks</h1>; }\nexport { x } from "@paperclipai/shared";\nexport const L = "Paperclip";\n`;
  const out = rewriteBrand(src, ".tsx");
  assert.match(out, /This Staples rocks/);
  assert.match(out, /L = "Staples"/);
  assert.match(out, /@paperclipai\/shared/);
});
