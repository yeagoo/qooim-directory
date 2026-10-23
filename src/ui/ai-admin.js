const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const number = (value) => Number(value ?? 0).toLocaleString("zh-CN");
function usagePanel(usage) {
  const current = usage.currentMonth;
  const budget = usage.monthlyTokens;
  const percent = budget ? Math.min(100, Math.round((current.used / budget) * 100)) : 0;
  const summary = budget
    ? `已用 ${number(current.used)} / ${number(budget)} token（${percent}%）${current.used >= budget ? " · 本月预算已用完，新任务会被拒绝" : ""}`
    : `已用 ${number(current.used)} token · 尚未配置预算`;
  return `<section class="panel"><h2>用量</h2><p id="ai-usage" class="muted">本月 ${escape(usage.months[0]?.month)} · ${current.jobs} 个任务 · ${summary}</p>${budget ? `<progress id="ai-usage-bar" max="100" value="${percent}">${percent}%</progress>` : ""}<div class="table-wrap"><table id="ai-usage-months"><thead><tr><th>月份</th><th>任务</th><th>输入 token</th><th>输出 token</th><th>合计</th></tr></thead><tbody>${usage.months.map((m) => `<tr><td>${escape(m.month)}</td><td>${number(m.jobs)}</td><td>${number(m.tokensIn)}</td><td>${number(m.tokensOut)}</td><td>${number(m.tokensIn + m.tokensOut)}</td></tr>`).join("")}</tbody></table></div><p class="muted">统计包含全部状态的任务；超过保留期的旧任务会汇总为月度用量后删除，合计不变。</p></section>`;
}
const statusLabels = {
  pending: "排队中",
  processing: "处理中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
const kindLabels = { generate: "生成", translate: "翻译", seo: "SEO", enrich: "富字段", compare: "对比" };
const errorLabels = { cancelled_by_operator: "操作员取消" };
const time = (value) => (value ? new Date(value).toLocaleString("zh-CN") : "—");
const jobsPanel = `<section class="panel" id="ai-jobs"><h2>任务</h2><div class="actions"><label for="ai-job-status">状态</label><select id="ai-job-status"><option value="">全部</option>${Object.entries(statusLabels).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select><button id="refresh-ai-jobs" class="secondary">刷新任务</button></div><div class="table-wrap"><table id="ai-job-list"><thead><tr><th>类型</th><th>状态</th><th>错误</th><th>输入 / 输出 token</th><th>操作者</th><th>创建 / 结束</th><th>操作</th></tr></thead><tbody><tr><td colspan="7" class="muted">加载中…</td></tr></tbody></table></div><div class="actions"><button id="ai-jobs-prev" class="secondary" disabled>上一页</button><span id="ai-jobs-page" class="muted">第 1 页</span><button id="ai-jobs-next" class="secondary" disabled>下一页</button></div></section>`;
function jobRow(job, write = true) {
  const actions = [];
  // Read-only operators get no cancel/retry buttons (the server needs site write).
  if (write && (job.status === "pending" || job.status === "processing"))
    actions.push(`<button class="secondary cancel-ai-job" data-id="${escape(job.id)}">取消</button>`);
  if (job.status === "failed" || job.status === "cancelled") {
    if (job.retriedBy) actions.push(`<span class="muted">已重试</span>`);
    else if (write)
      actions.push(`<button class="secondary retry-ai-job" data-id="${escape(job.id)}">重试</button>`);
  }
  return `<tr data-id="${escape(job.id)}" data-status="${escape(job.status)}"><td>${escape(kindLabels[job.kind] || job.kind)}${job.retryOf ? `<br><span class="muted">重试自 ${escape(job.retryOf.slice(0, 8))}</span>` : ""}</td><td>${escape(statusLabels[job.status] || job.status)}</td><td>${job.error ? `<code>${escape(errorLabels[job.error] || job.error)}</code>` : "—"}</td><td>${number(job.tokens.input)} / ${number(job.tokens.output)}</td><td>${escape(job.actor ?? "—")}</td><td>${escape(time(job.createdAt))}<br><span class="muted">${escape(time(job.completedAt))}</span></td><td>${actions.join(" ") || "—"}</td></tr>`;
}
// Task list with its own filter/page state; actions disable the whole panel until done.
function bindJobs(site, workspace, api, notice, write = true) {
  const panel = workspace.querySelector("#ai-jobs");
  const state = { status: "", page: 1, busy: false, hasMore: false };
  const setBusy = (busy) => {
    state.busy = busy;
    panel.setAttribute("aria-busy", String(busy));
    for (const button of panel.querySelectorAll("button, select")) button.disabled = busy;
    if (!busy) {
      panel.querySelector("#ai-jobs-prev").disabled = state.page <= 1;
      panel.querySelector("#ai-jobs-next").disabled = !state.hasMore;
    }
  };
  const load = async () => {
    const query = new URLSearchParams({ site, page: String(state.page) });
    if (state.status) query.set("status", state.status);
    const data = await api("/ai/jobs?" + query);
    state.hasMore = data.hasMore;
    panel.querySelector("#ai-job-list tbody").innerHTML =
      data.items.map((job) => jobRow(job, write)).join("") ||
      `<tr><td colspan="7" class="muted">${state.page > 1 ? "这一页没有任务。" : "暂无任务。"}</td></tr>`;
    panel.querySelector("#ai-jobs-page").textContent = `第 ${state.page} 页`;
  };
  const run = async (work, success) => {
    if (state.busy) return;
    setBusy(true);
    try {
      await work();
      if (success) notice(success);
    } catch (error) {
      notice(error.message, true);
    } finally {
      setBusy(false);
    }
  };
  panel.querySelector("#ai-job-status").addEventListener("change", (event) => {
    state.status = event.currentTarget.value;
    state.page = 1;
    run(load);
  });
  panel.querySelector("#refresh-ai-jobs").addEventListener("click", () => run(load));
  panel.querySelector("#ai-jobs-prev").addEventListener("click", () => {
    if (state.page <= 1) return;
    state.page--;
    run(load);
  });
  panel.querySelector("#ai-jobs-next").addEventListener("click", () => {
    if (!state.hasMore) return;
    state.page++;
    run(load);
  });
  panel.querySelector("#ai-job-list").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-id]");
    if (!button || button.disabled) return;
    const id = button.dataset.id;
    const cancel = button.classList.contains("cancel-ai-job");
    if (!cancel && !button.classList.contains("retry-ai-job")) return;
    run(
      async () => {
        await api(`/ai/jobs/${encodeURIComponent(id)}/${cancel ? "cancel" : "retry"}`, { site });
        await load();
      },
      cancel ? "任务已取消。" : "已创建重试任务。",
    );
  });
  return run(load);
}
const promptKinds = ["generate", "translate", "seo", "enrich", "compare"];
const versionLabel = (entry) =>
  `v${entry.version}${entry.builtin ? "（内置）" : entry.note ? `（${entry.note}）` : ""}`;
// Per-kind version select with a read-only view of the chosen instructions; global
// admins also get the form for creating a new (immutable) version.
function promptsPanel(prompts, selected, global, write = true) {
  const kinds = promptKinds
    .map((kind) => {
      const list = prompts.kinds[kind] || [];
      const current = selected[kind] ?? 1;
      const options = list.some((entry) => entry.version === current)
        ? list
        : [{ version: current, note: "不存在", builtin: false }, ...list];
      const shown = list.find((entry) => entry.version === current);
      return `<div class="ai-prompt-kind" data-kind="${kind}"><label for="ai-prompt-${kind}">${escape(kindLabels[kind])}</label><select id="ai-prompt-${kind}" data-kind="${kind}">${options.map((entry) => `<option value="${entry.version}" ${entry.version === current ? "selected" : ""}>${escape(versionLabel(entry))}</option>`).join("")}</select><pre id="ai-prompt-text-${kind}" style="white-space:pre-wrap">${escape(shown?.instructions ?? "该版本不存在。")}</pre><p class="muted" id="ai-prompt-meta-${kind}">${escape(promptMeta(shown))}</p></div>`;
    })
    .join("");
  const create = global
    ? `<h3>新建版本</h3><p class="muted">版本创建后不能修改或删除；修改提示词就是新建一个版本，各站点需要自行选择后才会使用。</p><label for="ai-prompt-new-kind">任务类型</label><select id="ai-prompt-new-kind">${promptKinds.map((kind) => `<option value="${kind}">${escape(kindLabels[kind])}</option>`).join("")}</select><label for="ai-prompt-new-text">任务说明（最多 4000 字）</label><textarea id="ai-prompt-new-text" maxlength="4000" spellcheck="false"></textarea><label for="ai-prompt-new-note">备注（最多 200 字）</label><input id="ai-prompt-new-note" maxlength="200"><div class="actions"><button id="create-ai-prompt">创建新版本</button></div>`
    : `<p class="muted">只有站群管理员可以新建提示词版本。</p>`;
  const save = write
    ? `<div class="actions"><button id="save-ai-prompts">保存版本选择</button></div>`
    : `<p class="muted">只读：可以查看各版本内容，不能修改本站的版本选择。</p>`;
  return `<section class="panel" id="ai-prompts"><h2>提示词版本</h2><p class="muted">只能自定义任务说明；系统提示（用户内容按不可信数据处理、只返回 JSON）和输出格式固定不变。任务创建时记录当时选用的版本，之后修改选择不影响已创建的任务。</p>${kinds}${save}${create}</section>`;
}
function promptMeta(entry) {
  if (!entry) return "";
  if (entry.builtin) return "内置版本，只读";
  return `${entry.createdBy ?? "—"} · ${time(entry.createdAt)}`;
}
function bindPrompts(site, workspace, api, notice, prompts, rerender) {
  const panel = workspace.querySelector("#ai-prompts");
  const find = (kind, version) =>
    (prompts.kinds[kind] || []).find((entry) => entry.version === Number(version));
  const newKind = panel.querySelector("#ai-prompt-new-kind");
  const newText = panel.querySelector("#ai-prompt-new-text");
  const prefill = () => {
    if (!newKind || !newText) return;
    const kind = newKind.value;
    newText.value = find(kind, panel.querySelector(`#ai-prompt-${kind}`).value)?.instructions ?? "";
  };
  for (const select of panel.querySelectorAll("select[data-kind]"))
    select.addEventListener("change", () => {
      const kind = select.dataset.kind;
      const entry = find(kind, select.value);
      panel.querySelector(`#ai-prompt-text-${kind}`).textContent =
        entry?.instructions ?? "该版本不存在。";
      panel.querySelector(`#ai-prompt-meta-${kind}`).textContent = promptMeta(entry);
      if (newKind?.value === kind) prefill();
    });
  newKind?.addEventListener("change", prefill);
  prefill();
  const run = async (button, work) => {
    button.disabled = true;
    try {
      await work();
    } catch (error) {
      notice(error.message, true);
    } finally {
      button.disabled = false;
    }
  };
  panel.querySelector("#save-ai-prompts")?.addEventListener("click", (event) =>
    run(event.currentTarget, async () => {
      const promptVersions = Object.fromEntries(
        promptKinds.map((kind) => [kind, Number(panel.querySelector(`#ai-prompt-${kind}`).value)]),
      );
      await api("/ai/config", { site, promptVersions });
      await rerender();
      notice("提示词版本选择已保存。");
    }),
  );
  panel.querySelector("#create-ai-prompt")?.addEventListener("click", (event) =>
    run(event.currentTarget, async () => {
      const note = panel.querySelector("#ai-prompt-new-note").value.trim();
      const created = await api("/ai/prompts", {
        kind: newKind.value,
        instructions: newText.value,
        ...(note ? { note } : {}),
      });
      await rerender();
      notice(`已创建${kindLabels[newKind.value] ?? ""}提示词 v${created.version}，选择后才会用于本站。`);
    }),
  );
}
// UI hint only; the server enforces every permission. Without access info
// (older callers) the page asks /me and allows site writes.
const READ_ONLY_NOTE = "只读：可以查看配置、提示词、用量和任务，不能修改。";
export async function renderAi(site, workspace, api, notice, access) {
  const [config, usage, prompts, me] = await Promise.all([
    api("/ai/config?site=" + encodeURIComponent(site)),
    api("/ai/usage?site=" + encodeURIComponent(site)),
    api("/ai/prompts"),
    access ? null : api("/me"),
  ]);
  const global = access ? Boolean(access.globalAdmin) : Boolean(me?.global_admin);
  const write = access ? Boolean(access.write) : true;
  const off = write ? "" : " disabled";
  const rerender = () => renderAi(site, workspace, api, notice, access);
  workspace.innerHTML = `<a href="#site/${encodeURIComponent(site)}">← 站点配置</a><span class="eyebrow"> / AI</span> · <a href="#ai-billing/${encodeURIComponent(site)}">用量对账与余额 →</a><h1>AI 生成与翻译 · ${escape(site)}</h1><p class="muted">服务端调用 OpenAI-compatible 端点；密钥加密保存，不回显。AI 输出只作为草稿建议，必须人工保存并发布。</p>${write ? "" : `<p class="muted access-note" id="access-note">${escape(READ_ONLY_NOTE)}</p>`}<section class="panel"><h2>供应商配置</h2><div class="split"><div><label for="ai-endpoint">HTTPS 端点</label><input id="ai-endpoint"${off} value="${escape(config.endpoint)}" placeholder="https://api.openai.com/v1/chat/completions"><label for="ai-model">模型</label><input id="ai-model"${off} value="${escape(config.model)}" placeholder="gpt-4.1-mini"></div><div><label for="ai-key">API Key</label><input id="ai-key"${off} type="password" autocomplete="new-password" placeholder="${config.hasKey ? "已保存，留空保持不变" : "首次配置必填"}"><label for="ai-budget">月度 token 预算</label><input id="ai-budget"${off} type="number" min="1000" max="100000000" step="1000" value="${config.monthlyTokens}"><label><input id="ai-enabled"${off} type="checkbox" ${config.enabled ? "checked" : ""}>启用本站 AI</label></div></div><div class="actions">${write ? '<button id="save-ai">保存配置</button>' : ""}<button id="refresh-ai" class="secondary">刷新</button></div><p id="ai-state" class="muted">${config.hasKey ? "已保存 API Key" : "尚未保存 API Key"} · 更新于 ${escape(config.updatedAt ?? "—")}</p></section>${promptsPanel(prompts, config.promptVersions || {}, global, write)}${usagePanel(usage)}${jobsPanel}<p id="message" role="status" aria-live="polite"></p>`;
  workspace.querySelector("#refresh-ai")?.addEventListener("click", rerender);
  bindPrompts(site, workspace, api, notice, prompts, rerender);
  await bindJobs(site, workspace, api, notice, write);
  workspace.querySelector("#save-ai")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const key = workspace.querySelector("#ai-key").value.trim();
      await api("/ai/config", {
        site,
        endpoint: workspace.querySelector("#ai-endpoint").value.trim(),
        model: workspace.querySelector("#ai-model").value.trim(),
        ...(key ? { key } : {}),
        enabled: workspace.querySelector("#ai-enabled").checked,
        monthlyTokens: Number(workspace.querySelector("#ai-budget").value),
      });
      await rerender();
      notice("AI 配置已保存。");
    } catch (error) {
      notice(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}
