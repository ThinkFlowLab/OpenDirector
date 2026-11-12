import assert from "node:assert/strict";
import test from "node:test";
import { assistantCitationFormatter } from "../src/canvas/assistantCitations.ts";
import { replyParts } from "../src/canvas/assistantActivity.ts";

const a = { id: "turn1search0", url: "https://example.test/a", title: 'A "quoted" source' };
const b = { id: "turn2view0", url: "https://example.test/b?q=(x)", title: "Source B" };
const cite = (...ids: string[]) => `\uE200cite${ids.map((id) => `\uE202${id}`).join("")}\uE201`;

test("multiple citation groups resolve actual sources with stable numbering and escaped titles", () => {
  const text = `赛果🌊${cite(a.id, b.id)}\n历史${cite(b.id, a.id, a.id)}`;
  const result = assistantCitationFormatter(text, [b, a])(text);
  assert.equal(result, '赛果🌊[\\[1\\]](<https://example.test/a> "A \\"quoted\\" source") [\\[2\\]](<https://example.test/b?q=(x)> "Source B")\n历史[\\[2\\]](<https://example.test/b?q=(x)> "Source B") [\\[1\\]](<https://example.test/a> "A \\"quoted\\" source")');
  assert.doesNotMatch(result, /[\uE200-\uE202]|turn1search0/);
});

test("ordinary Markdown, inline and fenced code, and quoted protocol examples keep their bytes", () => {
  const literal = cite(a.id);
  const text = `# Heading\n\n**中文 English** [ordinary](https://example.test)\n\n\`${literal}\`\n\n\`\`\`text\n${literal}\n\`\`\`\n\n    ${literal}\n`;
  assert.equal(assistantCitationFormatter(text, [a])(text), text);
  const mixed = text + `\nReal${literal}`;
  assert.equal(assistantCitationFormatter(mixed, [a])(mixed), text + '\nReal[\\[1\\]](<https://example.test/a> "A \\"quoted\\" source")');
});

test("missing and unsafe sources downgrade without inventing links or consuming adjacent prose", () => {
  const text = `Before${cite(a.id, b.id)}After\nUnknown\uE200other\uE202ref\uE201End\nPartial\uE200cite\uE202turn3search0 正文`;
  const result = assistantCitationFormatter(text, [{ ...a, url: "javascript:alert(1)" }, { ...b, url: "https://user:secret@example.test" }])(text);
  assert.equal(result, "Before[来源不可用] [来源不可用]After\nUnknown[来源不可用]End\nPartial[来源不可用] 正文");
  assert.doesNotMatch(result, /[\uE200-\uE202]|javascript|secret/);
  const orphan = 'Before\uE202turn1search0\uE201After';
  assert.doesNotMatch(assistantCitationFormatter(orphan)(orphan), /[\uE200-\uE202]|turn1search0/);
});

test("every streamed prefix hides unfinished protocol and eventually resolves it", () => {
  const token = cite(a.id);
  for (let i = 1; i < token.length; i++) {
    const text = `Text${token.slice(0, i)}`;
    assert.equal(assistantCitationFormatter(text, [a], true)(text), "Text");
  }
  const final = `Text${token}`;
  assert.match(assistantCitationFormatter(final, [a], true)(final), /example\.test\/a/);
  const stopped = `Text${token.slice(0, -1)}\nKeep this paragraph`;
  assert.equal(assistantCitationFormatter(stopped)(stopped), "Text[来源不可用]\nKeep this paragraph");
});

test("formatting after raw Unicode tool offsets keeps tool placement and source numbers", () => {
  const prefix = `🌊First${cite(a.id)}`;
  const text = `${prefix}Second${cite(b.id)}`;
  const parts = replyParts({ text, tools: [{ id: "tool", name: "read", status: "complete", textOffset: Array.from(prefix).length }] });
  assert.equal(parts[0].type, "text");
  assert.equal(parts[1].type, "tools");
  const format = assistantCitationFormatter(text, [a, b]);
  const rendered = parts.filter((p) => p.type === "text").map((p) => format(p.text));
  assert.match(rendered[0], /^🌊First\[\\\[1/);
  assert.match(rendered[1], /^Second\[\\\[2/);
  assert.equal(rendered.join(""), format(text));
});
