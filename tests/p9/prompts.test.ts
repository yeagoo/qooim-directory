import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";
import {
  AiWorker,
  BUILTIN_PROMPTS,
  SYSTEM_PROMPT,
  type AiTransport,
} from "../../src/server/ai.js";

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
  await f.pool.query("DELETE FROM audit_event WHERE action LIKE 'ai.%'");
  await configure();
});
const config = {
  site: "atlas",
  endpoint: "https://api.example.com/v1/chat/completions",
  model: "m",
  enabled: true,
  monthlyTokens: 100000,
};
async function configure() {
  await f.app.ai.saveConfig(f.admin, { ...config, key: "sk-test-12345678" });
}
const post = (path: string, body: unknown) => f.api(path, { method: "POST", body });
async function createPrompt(kind: string, instructions: string, note?: string) {
  const response = await post("/ai/prompts", { kind, instructions, ...(note ? { note } : {}) });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}
async function select(promptVersions: Record<string, number>) {
  const response = await post("/ai/config", { site: "atlas", promptVersions });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function job(kind = "seo") {
  return (await f.app.ai.create(f.editor, {
    site: "atlas",
    kind,
    locale: "zh",
    title: "示例",
    brief: "简洁",
  })) as { id: string; prompt_version: string };
}
async function row(id: string) {
  return (await f.pool.query("SELECT * FROM ai_job WHERE id=$1", [id])).rows[0];
}
// Records the messages of every provider call.
function recording() {
  const calls: Parameters<AiTransport>[0]["messages"][] = [];
  const transport: AiTransport = async (request) => {
    calls.push(request.messages);
    return { output: { title: "ok" }, tokensIn: 3, tokensOut: 2, model: "m" };
  };
  return { calls, transport };
}

test("P9 prompt list includes built-in v1 and only global admins create versions", async () => {
  const initial = await (await f.api("/ai/prompts")).json();
  assert.deepEqual(Object.keys(initial.kinds).sort(), ["generate", "seo", "translate"]);
  for (const kind of ["generate", "translate", "seo"] as const)
    assert.deepEqual(initial.kinds[kind], [
      {
        version: 1,
        instructions: BUILTIN_PROMPTS[kind],
        note: "内置",
        builtin: true,
        createdBy: null,
        createdAt: null,
      },
    ]);
  // Any logged-in operator can read the list.
  assert.deepEqual(await f.app.ai.prompts(f.viewer), initial);

  const v2 = await createPrompt("seo", "  Custom SEO v2  ", " 第一版 ");
  assert.equal(v2.version, 2);
  assert.equal(v2.instructions, "Custom SEO v2");
  assert.equal(v2.note, "第一版");
  assert.equal(v2.builtin, false);
  assert.equal(v2.createdBy, "owner@example.test");
  assert.ok(v2.createdAt);
  assert.equal((await createPrompt("seo", "Custom SEO v3")).version, 3);
  // Concurrent creates of one kind get distinct consecutive versions.
  const concurrent = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      f.app.ai.createPrompt(f.admin, { kind: "generate", instructions: "G" + i }),
    ),
  );
  assert.deepEqual(concurrent.map((p) => p.version).sort(), [2, 3, 4, 5, 6]);
  const listed = await (await f.api("/ai/prompts")).json();
  assert.deepEqual(
    listed.kinds.seo.map((p: { version: number; note: string; createdBy: string | null }) => [
      p.version,
      p.note,
      p.createdBy,
    ]),
    [
      [3, "", "owner@example.test"],
      [2, "第一版", "owner@example.test"],
      [1, "内置", null],
    ],
  );
  assert.deepEqual(
    listed.kinds.generate.map((p: { version: number }) => p.version),
    [6, 5, 4, 3, 2, 1],
  );
  assert.equal(listed.kinds.translate.length, 1);

  // Site editors and viewers cannot create versions.
  for (const operator of [f.editor, f.viewer])
    await assert.rejects(
      f.app.ai.createPrompt(operator, { kind: "seo", instructions: "x" }),
      { status: 403 },
    );
  // Validation.
  for (const body of [
    { kind: "seo", instructions: "   " },
    { kind: "seo", instructions: "x".repeat(4001) },
    { kind: "seo", instructions: "a\0b" },
    { kind: "seo", instructions: "x", note: "n".repeat(201) },
    { kind: "other", instructions: "x" },
    { kind: "seo", instructions: "x", version: 9 },
    { kind: "seo" },
  ])
    assert.equal((await post("/ai/prompts", body)).status, 400, JSON.stringify(body).slice(0, 60));
  assert.equal((await createPrompt("translate", "x".repeat(4000))).version, 2);
  // Versions are immutable: no edit or delete route.
  assert.equal((await post("/ai/prompts/2", { kind: "seo", instructions: "y" })).status, 405);
  assert.equal((await f.api("/ai/prompts", { method: "PUT", body: {} })).status, 405);
  const audits = (
    await f.pool.query(
      "SELECT actor_id,site_id,detail FROM audit_event WHERE action='ai.prompt.create' ORDER BY id",
    )
  ).rows;
  assert.equal(audits.length, 8);
  assert.deepEqual(audits[0], { actor_id: f.admin.id, site_id: null, detail: { kind: "seo", version: 2 } });
  assert.deepEqual(
    audits.filter((a) => a.detail.kind === "generate").map((a) => a.detail.version).sort(),
    [2, 3, 4, 5, 6],
  );
  assert.equal(
    (await f.pool.query("SELECT count(*)::int AS n FROM ai_prompt")).rows[0].n,
    8,
  );
});

test("P9 sites select existing prompt versions with write permission", async () => {
  await createPrompt("seo", "Custom SEO v2");
  const initial = await (await f.api("/ai/config?site=atlas")).json();
  assert.deepEqual(initial.promptVersions, { generate: 1, translate: 1, seo: 1 });
  // An unconfigured site reports the defaults too.
  assert.deepEqual(
    (await (await f.api("/ai/config?site=notes")).json()).promptVersions,
    { generate: 1, translate: 1, seo: 1 },
  );
  // Full config save with a partial selection.
  const saved = await post("/ai/config", { ...config, promptVersions: { seo: 2 } });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).promptVersions, { generate: 1, translate: 1, seo: 2 });
  assert.deepEqual(
    (await f.pool.query("SELECT prompt_versions FROM ai_config WHERE site_id='atlas'")).rows[0]
      .prompt_versions,
    { seo: 2 },
  );
  // Missing or malformed versions are rejected and nothing changes.
  for (const promptVersions of [{ seo: 9 }, { generate: 2 }, { seo: 0 }, { seo: 1.5 }, { other: 2 }, { seo: "2" }]) {
    const response = await post("/ai/config", { site: "atlas", promptVersions });
    assert.equal(response.status, 400, JSON.stringify(promptVersions));
  }
  const missing = await post("/ai/config", { site: "atlas", promptVersions: { seo: 9 } });
  assert.match((await missing.json()).error, /提示词版本不存在/);
  // Saving the provider config without promptVersions keeps the selection; key stays optional.
  assert.deepEqual(
    (await f.app.ai.saveConfig(f.editor, { ...config, model: "m2" })).promptVersions,
    { generate: 1, translate: 1, seo: 2 },
  );
  // Selection-only save; version 1 is the default and is not stored.
  await createPrompt("translate", "Custom translate v2");
  assert.deepEqual((await select({ translate: 2 })).promptVersions, {
    generate: 1,
    translate: 2,
    seo: 2,
  });
  assert.deepEqual((await select({ seo: 1 })).promptVersions, { generate: 1, translate: 2, seo: 1 });
  assert.deepEqual(
    (await f.pool.query("SELECT prompt_versions FROM ai_config WHERE site_id='atlas'")).rows[0]
      .prompt_versions,
    { translate: 2 },
  );
  // Viewers and operators without grants cannot change the selection; editors can.
  await assert.rejects(
    f.app.ai.saveConfig(f.viewer, { site: "atlas", promptVersions: { seo: 2 } }),
    { status: 403 },
  );
  await assert.rejects(
    f.app.ai.saveConfig(f.editor, { site: "notes", promptVersions: { seo: 2 } }),
    { status: 403 },
  );
  assert.equal(
    (await f.app.ai.saveConfig(f.editor, { site: "atlas", promptVersions: { seo: 2 } }))
      .promptVersions.seo,
    2,
  );
  // A selection needs a configured provider first.
  const unconfigured = await post("/ai/config", { site: "notes", promptVersions: { seo: 2 } });
  assert.equal(unconfigured.status, 409);
  assert.equal((await post("/ai/config", { site: "atlas", promptVersions: { seo: 2 }, extra: 1 })).status, 400);
  // Existing config semantics are unchanged.
  const first = await post("/ai/config", { ...config, site: "notes" });
  assert.equal(first.status, 400);
  assert.match((await first.json()).error, /API Key/);
});

test("P9 jobs record the selected version and the worker sends its instructions", async () => {
  await createPrompt("seo", "CUSTOM-SEO-V2: keep it short.");
  await createPrompt("seo", "CUSTOM-SEO-V3");
  await select({ seo: 2 });
  const seo = await job("seo");
  assert.equal(seo.prompt_version, "v2");
  const generate = await job("generate");
  assert.equal(generate.prompt_version, "v1");
  // Changing the selection after creation does not affect existing jobs.
  await select({ seo: 3 });
  const later = await job("seo");
  assert.equal(later.prompt_version, "v3");
  assert.equal((await row(seo.id)).prompt_version, "v2");

  const { calls, transport } = recording();
  const worker = new AiWorker(f.pool, f.key, transport);
  for (let i = 0; i < 3; i++) assert.equal(await worker.runOnce(), true);
  assert.equal(await worker.runOnce(), false);
  assert.equal(calls.length, 3);
  const data = JSON.stringify({ locale: "zh", title: "示例", description: "", url: "", brief: "简洁" });
  assert.deepEqual(calls[0], [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `<task>CUSTOM-SEO-V2: keep it short.</task>\n<data>${data}</data>` },
  ]);
  assert.deepEqual(calls[1], [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `<task>${BUILTIN_PROMPTS.generate}</task>\n<data>${data}</data>` },
  ]);
  assert.equal(calls[2]![1]!.content, `<task>CUSTOM-SEO-V3</task>\n<data>${data}</data>`);
  assert.match(SYSTEM_PROMPT, /untrusted data/);
  for (const id of [seo.id, generate.id, later.id]) assert.equal((await row(id)).status, "done");
  const detail = await (await f.api(`/ai/jobs/${seo.id}?site=atlas`)).json();
  assert.equal(detail.promptVersion, "v2");
  assert.equal((await f.app.ai.job(f.viewer, "atlas", later.id)).promptVersion, "v3");
});

test("P9 retry uses the prompt selection at retry time", async () => {
  await createPrompt("seo", "SEO v2");
  await createPrompt("seo", "SEO v3");
  await select({ seo: 2 });
  const original = await job("seo");
  await f.pool.query(
    "UPDATE ai_job SET status='failed',error_code='provider_http_500',completed_at=now() WHERE id=$1",
    [original.id],
  );
  await select({ seo: 3 });
  const response = await post(`/ai/jobs/${original.id}/retry`, { site: "atlas" });
  assert.equal(response.status, 201);
  const retried = await response.json();
  assert.equal(retried.prompt_version, "v3");
  assert.equal((await row(retried.id)).prompt_version, "v3");
  assert.equal((await row(original.id)).prompt_version, "v2");
  const { calls, transport } = recording();
  assert.equal(await new AiWorker(f.pool, f.key, transport).runOnce(), true);
  assert.match(calls[0]![1]!.content, /^<task>SEO v3<\/task>/);
});

test("P9 a job whose prompt version is missing fails with prompt_missing", async () => {
  const ids: string[] = [];
  for (const version of ["v7", "bogus", "v0"]) {
    const { id } = await job("translate");
    await f.pool.query("UPDATE ai_job SET prompt_version=$2 WHERE id=$1", [id, version]);
    ids.push(id);
  }
  const { calls, transport } = recording();
  const worker = new AiWorker(f.pool, f.key, transport);
  for (const _ of ids) assert.equal(await worker.runOnce(), true);
  // Failed at once, without a retry, and the provider was never called.
  assert.equal(await worker.runOnce(), false);
  assert.equal(calls.length, 0);
  for (const id of ids) {
    const failed = await row(id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error_code, "prompt_missing");
    assert.equal(failed.attempts, 1);
    assert.equal(failed.tokens_in, 0);
  }
});

test("P9 AI settings page selects prompt versions and admins create new ones", async () => {
  await createPrompt("seo", "SEO instructions v2", "短标题");
  const session = await f.browse(f.admin, "#ai/atlas");
  try {
    const { page } = session;
    await page.waitForSelector("#ai-prompts #ai-prompt-seo");
    assert.equal(await page.getAttribute('a[href="#ai-billing/atlas"]', "href"), "#ai-billing/atlas");
    assert.ok(await page.isVisible("#save-ai"));
    assert.equal(await page.inputValue("#ai-prompt-seo"), "1");
    assert.equal(await page.textContent("#ai-prompt-text-seo"), BUILTIN_PROMPTS.seo);
    assert.deepEqual(
      await page.locator("#ai-prompt-seo option").allTextContents(),
      ["v2（短标题）", "v1（内置）"],
    );
    // The new-version form is prefilled with the selected version of the chosen kind.
    assert.equal(await page.inputValue("#ai-prompt-new-text"), BUILTIN_PROMPTS.generate);
    await page.selectOption("#ai-prompt-seo", "2");
    assert.equal(await page.textContent("#ai-prompt-text-seo"), "SEO instructions v2");
    await page.selectOption("#ai-prompt-new-kind", "seo");
    assert.equal(await page.inputValue("#ai-prompt-new-text"), "SEO instructions v2");
    await page.click("#save-ai-prompts");
    await page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.includes("提示词版本选择已保存"),
    );
    assert.deepEqual(
      (await f.pool.query("SELECT prompt_versions FROM ai_config WHERE site_id='atlas'")).rows[0]
        .prompt_versions,
      { seo: 2 },
    );
    assert.equal(await page.inputValue("#ai-prompt-seo"), "2");

    await page.selectOption("#ai-prompt-new-kind", "seo");
    await page.fill("#ai-prompt-new-text", "SEO instructions v3");
    await page.fill("#ai-prompt-new-note", "更严格");
    await page.click("#create-ai-prompt");
    await page.waitForFunction(() => document.querySelector("#message")?.textContent?.includes("v3"));
    const stored = (
      await f.pool.query("SELECT instructions,note,created_by FROM ai_prompt WHERE kind='seo' AND version=3")
    ).rows[0];
    assert.deepEqual(stored, { instructions: "SEO instructions v3", note: "更严格", created_by: f.admin.id });
    // Created, but the site keeps its selection until someone selects it.
    assert.equal(await page.inputValue("#ai-prompt-seo"), "2");
    assert.equal(await page.locator("#ai-prompt-seo option").count(), 3);
    // Validation errors are shown.
    await page.fill("#ai-prompt-new-text", "   ");
    await page.click("#create-ai-prompt");
    await page.waitForSelector("#message.error");
    // Saving the provider config keeps the prompt selection.
    await page.click("#save-ai");
    await page.waitForFunction(() => document.querySelector("#message")?.textContent?.includes("AI 配置已保存"));
    assert.equal(await page.inputValue("#ai-prompt-seo"), "2");
  } finally {
    await session.close();
  }
  // Editors select versions but get no create form.
  const editor = await f.browse(f.editor, "#ai/atlas");
  try {
    const { page } = editor;
    await page.waitForSelector("#ai-prompts #ai-prompt-seo");
    assert.equal(await page.locator("#create-ai-prompt").count(), 0);
    await page.selectOption("#ai-prompt-seo", "3");
    await page.click("#save-ai-prompts");
    await page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.includes("提示词版本选择已保存"),
    );
    assert.equal((await f.app.ai.config(f.admin, "atlas")).promptVersions.seo, 3);
  } finally {
    await editor.close();
  }
  // Viewers can browse versions but get no save button; the server rejects a change.
  const viewer = await f.browse(f.viewer, "#ai/atlas");
  try {
    const { page } = viewer;
    await page.waitForSelector("#ai-prompts #ai-prompt-seo");
    await page.selectOption("#ai-prompt-seo", "1");
    assert.equal(await page.locator("#save-ai-prompts, #create-ai-prompt").count(), 0);
    assert.match((await page.textContent("#ai-prompts")) ?? "", /只读/);
    await assert.rejects(
      f.app.ai.saveConfig(f.viewer, { site: "atlas", promptVersions: { seo: 1 } }),
      (error: { status?: number }) => error.status === 403,
    );
    assert.equal((await f.app.ai.config(f.admin, "atlas")).promptVersions.seo, 3);
  } finally {
    await viewer.close();
  }
});
