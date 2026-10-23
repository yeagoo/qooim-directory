import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { setup, type Fixture } from "../p6/helpers.js";
import { CollectorWorker } from "../../src/server/collectors.js";
import type { Operator } from "../../src/server/operators.js";

// Role-aware admin pages: actions an operator cannot perform are hidden or
// disabled (the server still enforces every permission).
let f: Fixture;
let mediaId: string, sourceId: string, taskId: string, candidateId: string;
let failedJob: string, pendingJob: string;

const basePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
function png(seed: number) {
  const data = Buffer.alloc(1000, 0);
  basePng.copy(data);
  data.writeUInt32BE(seed, 996);
  return data;
}

before(async () => {
  f = await setup();
  // Media item with two versions.
  const item = await f.app.media.upload(f.admin, {
    site: "atlas",
    filename: "cover.png",
    mime: "image/png",
    alt: "封面",
    data: png(1).toString("base64"),
  });
  mediaId = item.id;
  await f.app.media.replace(f.admin, mediaId, {
    filename: "cover-2.png",
    mime: "image/png",
    data: png(2).toString("base64"),
  });
  // Collector source, failed task and pending candidate.
  sourceId = (
    await f.app.collectors.save(f.admin, {
      siteId: "atlas",
      kind: "rss",
      config: { url: "https://feed.example.test/rss", locale: "zh" },
      enabled: true,
      intervalSeconds: 3600,
      expectedVersion: 0,
    })
  ).id;
  taskId = (
    await f.pool.query(
      `INSERT INTO collector_task(source_id,source_version,status,attempts,error_code,completed_at,created_at)
       SELECT id,version,'failed',5,'fetch_failed',now()-interval '2 hours',now()-interval '2 hours'
       FROM collector_source WHERE id=$1 RETURNING id`,
      [sourceId],
    )
  ).rows[0].id;
  // A pending candidate from one real collection run (stubbed feed).
  await f.app.collectors.enqueue(f.admin, sourceId, randomUUID());
  const worker = new CollectorWorker(f.pool, async () => ({
    notModified: false,
    text: `<?xml version="1.0"?><rss><channel><title>Feed</title><item><guid>item-1</guid><title>候选一</title><link>https://example.com/item-1</link><description>描述</description></item></channel></rss>`,
    etag: null,
  }));
  assert.equal(await worker.runOnce(), "done");
  candidateId = (
    await f.pool.query(
      "SELECT id FROM collector_candidate WHERE source_id=$1 AND status='pending'",
      [sourceId],
    )
  ).rows[0].id;
  // AI config, a failed job and a pending job.
  await f.app.ai.saveConfig(f.admin, {
    site: "atlas",
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "m",
    key: "sk-test-12345678",
    enabled: true,
    monthlyTokens: 100000,
  });
  const job = async (status: string, secondsAgo: number) =>
    (
      await f.pool.query(
        `INSERT INTO ai_job(site_id,actor_id,kind,payload,status,error_code,tokens_in,tokens_out,created_at,completed_at)
         VALUES('atlas',$1,'translate',$2,$3,$4,3,2,now()-$5::int*interval '1 second',
           CASE WHEN $3='failed' THEN now() END) RETURNING id`,
        [
          f.editor.id,
          { locale: "en", title: "Hello", brief: "" },
          status,
          status === "failed" ? "provider_http_500" : null,
          secondsAgo,
        ],
      )
    ).rows[0].id as string;
  failedJob = await job("failed", 20);
  pendingJob = await job("pending", 10);
  // Reconciliation row and balance settings.
  const month = new Date().toISOString().slice(0, 7);
  await f.app.aiBilling.saveReport(f.admin, {
    site: "atlas",
    month,
    tokensIn: 100,
    tokensOut: 50,
  });
  await f.app.aiBilling.saveBalance(f.admin, {
    site: "atlas",
    url: "https://api.example.com/v1/balance",
    field: "data.balance",
    enabled: true,
  });
});
after(async () => {
  await f?.close();
});

const count = (page: Page, selector: string) => page.locator(selector).count();
const note = async (page: Page) =>
  (await page.locator("#access-note").count())
    ? ((await page.textContent("#access-note")) ?? "")
    : null;
async function visit(
  operator: Operator,
  hash: string,
  ready: string,
  check: (page: Page) => Promise<void>,
) {
  const session = await f.browse(operator, hash);
  try {
    await session.page.waitForSelector(ready);
    await check(session.page);
    // Let image requests finish so none is routed after the browser closes.
    await session.page.waitForFunction(() =>
      [...document.images].every((image) => image.complete),
    );
  } finally {
    await session.close();
  }
}

test("P11 media page hides write actions from viewers", async () => {
  const card = `.media-item[data-id="${mediaId}"]`;
  const full = async (page: Page) => {
    assert.equal(await count(page, "#upload-media"), 1);
    assert.equal(await count(page, "#media-batch-files"), 1);
    assert.equal(await count(page, "#start-batch"), 1);
    assert.equal(await count(page, `${card} .replace-media`), 1);
    assert.equal(await count(page, `${card} .delete-media`), 1);
    assert.equal(await note(page), null);
    await page.click(`${card} .history-media`);
    await page.waitForSelector("#media-history .version-row");
    assert.equal(await count(page, "#media-history .restore-version"), 1);
    assert.equal(await count(page, "#media-history .delete-version"), 2);
  };
  await visit(f.admin, "#media/atlas", card, full);
  await visit(f.editor, "#media/atlas", card, full);
  await visit(f.viewer, "#media/atlas", card, async (page) => {
    assert.match((await note(page)) ?? "", /只读/);
    for (const selector of [
      "#upload-media",
      "#media-file",
      "#media-batch-panel",
      "#media-batch-files",
      "#start-batch",
      "#media-replace",
      ".replace-media",
      ".delete-media",
    ])
      assert.equal(await count(page, selector), 0, selector);
    assert.equal(await count(page, "#refresh-media"), 1);
    assert.equal(await count(page, `${card} .copy-media`), 1);
    // History and previews stay readable.
    await page.click(`${card} .history-media`);
    await page.waitForSelector("#media-history .version-row");
    assert.equal(await count(page, "#media-history .version-row"), 2);
    assert.equal(await count(page, "#media-history .restore-version"), 0);
    assert.equal(await count(page, "#media-history .delete-version"), 0);
    assert.equal(await count(page, "#media-history img"), 2);
  });
});

test("P11 collector page limits source management to global admins", async () => {
  const ready = `#collector-tasks tr[data-task="${taskId}"]`;
  const review = async (page: Page, visible: boolean) => {
    const n = visible ? 1 : 0;
    assert.equal(await count(page, ".accept-collector"), n);
    assert.equal(await count(page, ".reject-collector"), n);
    assert.equal(await count(page, ".candidate-check"), n);
    assert.equal(await count(page, "#select-all-candidates"), n);
    assert.equal(await count(page, "#batch-accept"), n);
    assert.equal(await count(page, "#batch-reject"), n);
  };
  const manage = async (page: Page, visible: boolean) => {
    const n = visible ? 1 : 0;
    assert.equal(await count(page, "#save-collector"), n);
    assert.equal(await count(page, "#collector-kind"), n);
    assert.equal(await count(page, ".sync-collector"), n);
    assert.equal(await count(page, ".edit-collector"), n);
    assert.equal(await count(page, ".detail-collector"), n);
    assert.equal(await count(page, ".retry-task"), n);
  };
  await visit(f.admin, "#collectors/atlas", ready, async (page) => {
    await manage(page, true);
    await review(page, true);
    assert.equal(await note(page), null);
  });
  await visit(f.viewer, "#collectors/atlas", ready, async (page) => {
    await manage(page, false);
    await review(page, false);
    assert.match((await note(page)) ?? "", /只读/);
    assert.equal(await count(page, "#refresh-collectors"), 1);
    assert.match((await page.textContent("#collector-candidates")) ?? "", /候选一/);
    // Task paging still works for readers.
    await page.selectOption("#task-status", "failed");
    await page.waitForSelector(ready);
    assert.equal(await count(page, ".retry-task"), 0);
  });
  await visit(f.editor, "#collectors/atlas", ready, async (page) => {
    await manage(page, false);
    await review(page, true);
    assert.match((await note(page)) ?? "", /仅站群管理员/);
    // The review actions the editor sees do work (batch path).
    await page.check(`.candidate-check[data-id="${candidateId}"]`);
    await page.click("#batch-accept");
    await page.waitForSelector("#collector-batch-result:not([hidden])");
    assert.match(
      (await page.textContent("#collector-batch-result")) ?? "",
      /成功 1 条，失败 0 条/,
    );
  });
  const { rows } = await f.pool.query(
    "SELECT status FROM collector_candidate WHERE id=$1",
    [candidateId],
  );
  assert.equal(rows[0].status, "accepted");
});

test("P11 AI page shows prompt creation to global admins and writes to editors", async () => {
  const ready = `#ai-job-list tr[data-id="${failedJob}"]`;
  const writes = async (page: Page, visible: boolean) => {
    const n = visible ? 1 : 0;
    assert.equal(await count(page, "#save-ai"), n);
    assert.equal(await count(page, "#save-ai-prompts"), n);
    assert.equal(await count(page, `tr[data-id="${failedJob}"] .retry-ai-job`), n);
    assert.equal(await count(page, `tr[data-id="${pendingJob}"] .cancel-ai-job`), n);
    assert.equal(await page.isDisabled("#ai-endpoint"), !visible);
    assert.equal(await page.isDisabled("#ai-key"), !visible);
  };
  await visit(f.admin, "#ai/atlas", ready, async (page) => {
    await writes(page, true);
    assert.equal(await count(page, "#create-ai-prompt"), 1);
    assert.equal(await note(page), null);
  });
  await visit(f.editor, "#ai/atlas", ready, async (page) => {
    await writes(page, true);
    assert.equal(await count(page, "#create-ai-prompt"), 0);
    assert.match(
      (await page.textContent("#ai-prompts")) ?? "",
      /只有站群管理员可以新建提示词版本/,
    );
    assert.equal(await note(page), null);
  });
  await visit(f.viewer, "#ai/atlas", ready, async (page) => {
    await writes(page, false);
    assert.equal(await count(page, "#create-ai-prompt"), 0);
    assert.match((await note(page)) ?? "", /只读/);
    // Prompt versions and usage stay readable.
    assert.equal(await count(page, "#ai-prompt-seo"), 1);
    assert.equal(await count(page, "#ai-usage-months"), 1);
    assert.equal(await count(page, "#refresh-ai"), 1);
  });
});

test("P11 AI billing page hides reconciliation and balance writes from viewers", async () => {
  const ready = "#ai-reconcile tr[data-month]";
  const full = async (page: Page) => {
    for (const selector of [
      "#save-reconcile",
      "#import-reconcile",
      "#save-balance",
      "#check-balance",
    ])
      assert.equal(await count(page, selector), 1, selector);
    assert.equal(await page.isEnabled("#check-balance"), true);
    assert.equal(await page.isEnabled("#balance-url"), true);
    assert.equal(await note(page), null);
  };
  await visit(f.admin, "#ai-billing/atlas", ready, full);
  await visit(f.editor, "#ai-billing/atlas", ready, full);
  await visit(f.viewer, "#ai-billing/atlas", ready, async (page) => {
    for (const selector of [
      "#save-reconcile",
      "#reconcile-month",
      "#import-reconcile",
      "#reconcile-csv",
      "#save-balance",
      "#check-balance",
    ])
      assert.equal(await count(page, selector), 0, selector);
    assert.equal(await page.isDisabled("#balance-url"), true);
    assert.equal(await page.isDisabled("#balance-enabled"), true);
    assert.match((await note(page)) ?? "", /只读/);
    assert.match((await page.textContent("#balance-state")) ?? "", /已启用/);
    // Pages called without access info keep every action (older callers).
    // A string keeps the bundler's helpers (e.g. __name) out of the page.
    const legacy = await page.evaluate(`(async () => {
      const { renderAiBilling } = await import("/assets/ai-billing-admin.js");
      const box = document.createElement("div");
      document.body.append(box);
      await renderAiBilling("atlas", box, async (path) => (await fetch("/admin/api" + path)).json(), () => {});
      return {
        save: box.querySelectorAll("#save-reconcile").length,
        balance: box.querySelectorAll("#save-balance").length,
        note: box.querySelectorAll("#access-note").length,
      };
    })()`);
    assert.deepEqual(legacy, { save: 1, balance: 1, note: 0 });
  });
});
