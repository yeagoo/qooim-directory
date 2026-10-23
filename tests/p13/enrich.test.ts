// M13b AI "enrich": drafts the rich listing fields of one locale; editors apply them to the master.
import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";
import { AiWorker, BUILTIN_PROMPTS, ENRICH_SYSTEM_PROMPT, SYSTEM_PROMPT, type AiTransport } from "../../src/server/ai.js";

let f: Fixture;
before(async () => {
  f = await setup();
});
after(async () => {
  await f?.close();
});
beforeEach(async () => {
  await f.pool.query("DELETE FROM ai_job");
  await f.pool.query("DELETE FROM ai_prompt");
  await f.pool.query("DELETE FROM ai_config");
  await f.app.ai.saveConfig(f.admin, {
    site: "atlas",
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "m",
    enabled: true,
    monthlyTokens: 100000,
    key: "sk-test-12345678",
  });
});
const rich = {
  tagline: "一起设计",
  features: ["实时协作", "原型"],
  useCases: ["界面设计"],
  pros: ["免费版"],
  cons: ["需联网"],
  content: "## 概览\n\n协作设计工具。",
  faqs: [{ question: "免费吗？", answer: "有免费版。" }],
};
function fake(output: unknown) {
  const calls: Parameters<AiTransport>[0][] = [];
  const transport: AiTransport = async (request) => {
    calls.push(request);
    return { output, tokensIn: 10, tokensOut: 20, model: "m" };
  };
  return { calls, transport };
}
const create = (kind: string) =>
  f.app.ai.create(f.editor, {
    site: "atlas",
    kind,
    locale: "zh",
    title: "Figma",
    description: "在线设计工具",
    url: "https://figma.com",
    brief: "",
  }) as Promise<{ id: string }>;
const row = async (id: string) => (await f.pool.query("SELECT * FROM ai_job WHERE id=$1", [id])).rows[0];

test("P13 enrich jobs use their own prompt and store the validated rich fields", async () => {
  const job = await create("enrich");
  const { calls, transport } = fake(rich);
  assert.equal(await new AiWorker(f.pool, f.key, transport).runOnce(), true);
  const done = await row(job.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.output, rich);
  assert.equal(calls[0].maxTokens, 4000);
  assert.deepEqual(calls[0].messages[0], { role: "system", content: ENRICH_SYSTEM_PROMPT });
  assert.match(calls[0].messages[1].content, new RegExp(`^<task>${BUILTIN_PROMPTS.enrich.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</task>`));
  assert.match(calls[0].messages[1].content, /"url":"https:\/\/figma\.com"/);
  assert.match(ENRICH_SYSTEM_PROMPT, /untrusted data/);
  // Other kinds keep their prompt and token limit.
  await create("seo");
  const other = fake({ seoTitle: "t" });
  await new AiWorker(f.pool, f.key, other.transport).runOnce();
  assert.equal(other.calls[0].maxTokens, 900);
  assert.equal(other.calls[0].messages[0].content, SYSTEM_PROMPT);
});

test("P13 output that does not fit the kind fails as invalid_output", async () => {
  for (const [kind, output] of [
    ["enrich", { title: "not a rich field" }],
    ["enrich", { features: Array(13).fill("x") }],
    ["enrich", {}],
    ["generate", { tagline: "rich field on a plain job" }],
  ] as const) {
    await f.pool.query("DELETE FROM ai_job");
    const job = await create(kind);
    const worker = new AiWorker(f.pool, f.key, fake(output).transport);
    // Two attempts are retried after a delay; make them due immediately.
    for (let i = 0; i < 3; i++) {
      await f.pool.query("UPDATE ai_job SET available_at=now() WHERE id=$1", [job.id]);
      await worker.runOnce();
    }
    const failed = await row(job.id);
    assert.equal(failed.status, "failed", JSON.stringify(output));
    assert.equal(failed.error_code, "invalid_output");
    assert.equal(failed.output, null);
  }
});

test("P13 enrich has prompt versions like the other kinds", async () => {
  const prompts = await f.app.ai.prompts(f.admin);
  assert.deepEqual(Object.keys(prompts.kinds).sort(), ["enrich", "generate", "seo", "translate"]);
  const v2 = await f.app.ai.createPrompt(f.admin, { kind: "enrich", instructions: "Custom enrich" });
  assert.equal(v2.version, 2);
  await f.app.ai.saveConfig(f.admin, { site: "atlas", promptVersions: { enrich: 2 } });
  const job = await create("enrich");
  assert.equal((await row(job.id)).prompt_version, "v2");
  const { calls, transport } = fake(rich);
  await new AiWorker(f.pool, f.key, transport).runOnce();
  assert.match(calls[0].messages[1].content, /^<task>Custom enrich<\/task>/);
});

test("P13 mergeEnrichment writes rich fields into one locale and keeps the rest", async () => {
  const { mergeEnrichment } = await import("../../src/ui/content-admin.js");
  const data = {
    url: "https://figma.com",
    source: "manual",
    translations: {
      zh: { title: "Figma", description: "设计", tagline: "旧口号", pros: ["旧"] },
      en: { title: "Figma", description: "Design" },
    },
  };
  const merged = mergeEnrichment(data, "zh", { tagline: "新口号", features: ["协作"], title: "ignored" });
  assert.deepEqual(merged.translations.zh, {
    title: "Figma",
    description: "设计",
    tagline: "新口号",
    pros: ["旧"],
    features: ["协作"],
  });
  assert.deepEqual(merged.translations.en, data.translations.en);
  assert.equal(data.translations.zh.tagline, "旧口号");
  assert.throws(() => mergeEnrichment({ ...data, translations: { en: data.translations.en } }, "zh", { tagline: "x" }));
  // The merged data is a valid master.
  await f.app.content.saveResource(f.admin, { id: "figma", expectedVersion: 0, public: true, data: merged });
});
