// The user guide: every link and picture resolves, every ribbon tab has a topic, keys are
// Windows keys, and search finds the right topic for everyday questions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { parseTopic, renderMarkdown, slug, keysHtml, type Topic } from "../src/help/markdown";
import { buildIndex, search } from "../src/help/search";
import { TASKS } from "../src/ui/ribbon";

const DIR = "src/help/topics";
const topics: Topic[] = readdirSync(DIR).filter((f) => f.endsWith(".md")).map((f) => parseTopic(f.slice(0, -3), readFileSync(`${DIR}/${f}`, "utf8")));
const byId = new Map(topics.map((t) => [t.id, t]));
const headings = (t: Topic) => new Set([...t.body.matchAll(/^#{2,3}\s+(.*)$/gm)].map((m) => slug(m[1].replace(/\{\{app\}\}/g, "HDS"))));

test("help: every topic has a title, section and summary", () => {
  assert.ok(topics.length >= 30, `only ${topics.length} topics`);
  for (const t of topics) {
    assert.ok(t.title && t.title !== t.id, `${t.id}: title`);
    assert.ok(t.summary, `${t.id}: summary`);
    assert.ok(t.keywords.length >= 3, `${t.id}: keywords`);
    assert.match(t.body, /^# /m, `${t.id}: starts with a # heading`);
  }
  assert.ok(byId.has("welcome") && byId.has("shortcuts") && byId.has("whats-new"));
});

test("help: every link points at a topic (and heading) that exists", () => {
  for (const t of topics) {
    for (const [, target] of t.body.matchAll(/\]\(#([^)\s]+)\)/g)) {
      const [id, anchor] = target.split("/");
      const to = byId.get(id);
      assert.ok(to, `${t.id}: link to missing topic #${id}`);
      if (anchor) assert.ok(headings(to).has(anchor), `${t.id}: link to missing heading #${id}/${anchor}`);
    }
    for (const [, cmd] of t.body.matchAll(/\]\(cmd:([^)\s]+)\)/g)) assert.match(cmd, /^[\w-]+$/, `${t.id}: bad command link ${cmd}`);
  }
});

test("help: every picture exists", () => {
  for (const t of topics)
    for (const [, file] of t.body.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) assert.ok(existsSync(`public/help/${file}`), `${t.id}: missing public/help/${file}`);
});

test("help: F1 has a topic for every ribbon tab, and the reference lists every tab", () => {
  const ctx = new Set(topics.flatMap((t) => t.context));
  for (const task of TASKS) {
    assert.ok(ctx.has(`tab:${task.id}`), `no topic opens for tab:${task.id}`);
    assert.ok(byId.get("ribbon")!.body.includes(`{{ribbon:${task.id}}}`), `ribbon reference misses ${task.id}`);
  }
  const owners = new Map<string, string>();
  for (const t of topics) for (const c of t.context) {
    assert.ok(!owners.has(c), `${c} is claimed by both ${owners.get(c)} and ${t.id}`);
    owners.set(c, t.id);
  }
});

test("help: Windows key names only", () => {
  for (const t of topics) {
    assert.doesNotMatch(t.body, /[⌘⌥⇧⌃⏎]|\bCmd\b|\bCommand\+|\bOption\+|\bReturn key\b/, `${t.id}: Mac key name`);
    for (const [, k] of t.body.matchAll(/\[\[((?:[^\]]|\](?=\]\]))+)\]\]/g))
      for (const part of k.split(/\+(?!$)/)) assert.match(part, /^(Ctrl|Shift|Alt|Esc|Enter|Tab|Space|Delete|Backspace|Home|End|Page Up|Page Down|Up|Down|Left|Right|F\d{1,2}|[A-Z0-9]|[=\-,[\]])$/, `${t.id}: key "${part}" in [[${k}]]`);
  }
});

test("help: markdown renders tables, figures, call-outs and keys", () => {
  const html = renderMarkdown("# T\n\n## Two words\n\n| a | b |\n|---|---|\n| [[Ctrl+K]] | **x** |\n\n![Cap](p.png \"small\")\n\n> **Tip:** hi\n\n- one\n- two\n\n{{ribbon:home}}\n\nSee [it](#welcome) and [run](cmd:tool-cloud) in {{app}}.", { app: "HDS", img: (f) => `/help/${f}` });
  assert.match(html, /<h2 id="two-words">/);
  assert.match(html, /<table>.*<kbd>Ctrl<\/kbd><span>\+<\/span><kbd>K<\/kbd>.*<strong>x<\/strong>/s);
  assert.match(html, /<figure class="small"><img src="\/help\/p.png" alt="Cap"/);
  assert.match(html, /<aside class="callout tip">/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /data-gen="ribbon" data-arg="home"/);
  assert.match(html, /data-topic="welcome"/);
  assert.match(html, /in HDS\./);
  assert.equal(keysHtml("Ctrl+]"), '<span class="keys"><kbd>Ctrl</kbd><span>+</span><kbd>]</kbd></span>');
  assert.equal(keysHtml("Ctrl+-"), '<span class="keys"><kbd>Ctrl</kbd><span>+</span><kbd>-</kbd></span>');
});

test("help: search answers everyday questions with the right topic", () => {
  const index = buildIndex(topics, "HDS", (k, a) => (k === "ribbon" ? `ribbon ${a}` : ""));
  const top = (q: string) => search(index, q).slice(0, 3).map((h) => h.section.topic);
  const cases: [string, string][] = [
    ["callout leader", "callouts-leaders"],
    ["multileader", "callouts-leaders"],
    ["how do I redact", "redact"],
    ["set the scale", "scale"],
    ["calibrate", "scale"],
    ["onedrive", "m365"],
    ["window selection", "selecting"],
    ["crossing", "selecting"],
    ["page numbers", "page-marks"],
    ["bates", "page-marks"],
    ["stacked fractions", "measure"],
    ["revision cloud", "clouds-shapes"],
    ["signature", "signatures"],
    ["password", "security"],
    ["OCR scanned", "ocr"],
    ["save as image autocad", "save-images"],
    ["keyboard shortcuts", "shortcuts"],
    ["pan middle mouse", "navigate"],
    ["compare revisions overlay", "compare"],
    ["watermark", "page-marks"],
    ["extract image", "extract-image"],
    ["form fields calculation", "form-builder"],
  ];
  for (const [q, want] of cases) assert.ok(top(q).includes(want), `"${q}" → ${top(q).join(", ")} (wanted ${want})`);
  const h = search(index, "callout")[0];
  assert.match(h.snippet, /<mark>/);
  assert.equal(search(index, "").length, 0);
  assert.ok(search(index, "zzqx qqwv").length === 0);
});
