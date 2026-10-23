const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const defaults = {
  rss: { url: "https://example.com/feed.xml", locale: "zh" },
  npm: { query: "react", locale: "en" },
  json: {
    url: "https://example.com/items.json",
    itemsPath: "items",
    idField: "id",
    titleField: "title",
    descriptionField: "description",
    urlField: "url",
    locale: "zh",
  },
};
const statusLabels = {
  pending: "待审核",
  accepted: "已接受",
  rejected: "已拒绝",
  superseded: "已作废",
};
const time = (value) => (value ? new Date(value).toLocaleString() : "");
// Compacted candidates keep only their dedupe record; data is an empty object.
function candidateRows(rows) {
  return (
    rows
      .map((c) => {
        const title = c.compacted_at
          ? `<span class="muted">已归档（内容已压缩，仅保留去重记录）</span>`
          : `<strong>${escape(c.data?.translations?.[c.locale]?.title)}</strong><br><span class="muted">${escape(c.data?.url)}</span>`;
        return `<tr><td>${title}</td><td><code>${escape(c.external_id)}</code></td><td>${escape(statusLabels[c.status] || c.status)}${c.compacted_at ? " · 已归档" : ""}${c.accepted_resource_id ? `<br><span class="muted">${escape(c.accepted_resource_id)}</span>` : ""}</td><td>${escape(time(c.reviewed_at || c.created_at))}</td></tr>`;
      })
      .join("") ||
    '<tr><td colspan="4" class="muted">该来源还没有候选。</td></tr>'
  );
}
const taskStatusLabels = {
  pending: "排队中",
  processing: "处理中",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
};
// Config fields editable per source kind; locale is rendered as a select.
const configFields = {
  rss: [["url", "Feed URL"]],
  npm: [["query", "npm 关键词"]],
  json: [
    ["url", "JSON URL"],
    ["itemsPath", "条目路径"],
    ["idField", "ID 字段"],
    ["titleField", "标题字段"],
    ["descriptionField", "描述字段"],
    ["urlField", "URL 字段"],
  ],
};
// Retry operation ids survive re-renders: a retry that failed on the network
// (the server may or may not have created the task) reuses the same id, so
// clicking "重试" again is an idempotent replay instead of a second task.
const retryOperations = new Map();
const uncertain = (error) =>
  error instanceof TypeError || error instanceof SyntaxError;
const sourceLabel = (s) =>
  s.kind === "npm" ? "npm: " + (s.config?.query ?? "") : s.config?.url ?? "";
function taskRows(items, manage = true) {
  return (
    items
      .map(
        (t) =>
          `<tr data-task="${escape(t.id)}"><td>${escape(taskStatusLabels[t.status] || t.status)}${t.retryOf ? `<br><span class="muted">重试自 ${escape(t.retryOf.slice(0, 8))}</span>` : ""}</td><td>${escape(t.kind)}<br><span class="muted">${escape(t.source)}</span></td><td>${t.attempts}</td><td>${escape(t.error || t.result || "")}</td><td>${escape(time(t.createdAt))}${t.completedAt ? `<br><span class="muted">结束 ${escape(time(t.completedAt))}</span>` : ""}</td><td>${manage && t.status === "failed" ? `<button class="secondary retry-task" data-id="${escape(t.id)}">重试</button>` : ""}</td></tr>`,
      )
      .join("") || '<tr><td colspan="6" class="muted">没有符合条件的任务。</td></tr>'
  );
}
function editForm(s) {
  const hours = Math.min(168, Math.max(1, Math.round(s.interval_seconds / 3600)));
  const fields = (configFields[s.kind] || [])
    .map(
      ([key, label]) =>
        `<label for="edit-${key}">${escape(label)}</label><input id="edit-${key}" data-key="${key}" class="edit-config" value="${escape(s.config?.[key] ?? "")}">`,
    )
    .join("");
  const locale = s.config?.locale || "zh";
  return `<h2>编辑来源 · ${escape(s.kind)}</h2><p class="muted">版本 ${s.version}。保存后会取消该来源未完成的任务，并作废其待审核候选。</p><div class="split"><div>${fields}<label for="edit-locale">语言</label><select id="edit-locale"><option value="zh"${locale === "zh" ? " selected" : ""}>中文</option><option value="en"${locale === "en" ? " selected" : ""}>English</option></select></div><div><label for="edit-interval">同步间隔（小时，1–168）</label><input id="edit-interval" type="number" min="1" max="168" step="1" value="${hours}"><label><input id="edit-enabled" type="checkbox"${s.enabled ? " checked" : ""}>启用并参与定时采集</label></div></div><div class="actions"><button id="save-edit" data-id="${escape(s.id)}">保存修改</button><button id="cancel-edit" class="secondary">取消</button></div>`;
}
// UI hint only; the server enforces every permission. Sources, sync, task
// retry and candidate history need a global admin; review needs site write.
// Without access info (older callers) the page shows every action.
function accessNote(manage, review) {
  if (manage) return "";
  const text = review
    ? "仅站群管理员可以管理来源、同步、重试任务和查看候选历史；你可以审核候选。"
    : "只读：可以查看来源、任务和候选，不能修改。仅站群管理员可以管理来源和同步。";
  return `<p class="muted access-note" id="access-note">${escape(text)}</p>`;
}
export async function renderCollectors(site, workspace, api, notice, access) {
  const manage = access ? Boolean(access.globalAdmin) : true;
  const review = access ? Boolean(access.write) : true;
  const rerender = () => renderCollectors(site, workspace, api, notice, access);
  const sources = await api("/collectors?site=" + encodeURIComponent(site));
  const candidates = await api(
    "/collector-candidates?site=" + encodeURIComponent(site),
  );
  const usage = await api("/collectors/usage?site=" + encodeURIComponent(site));
  const tasks = await api("/collectors/tasks?site=" + encodeURIComponent(site));
  const full = usage.sources >= usage.sourceLimit;
  const quota = `<p class="muted" id="collector-usage">来源 ${usage.sources} / ${usage.sourceLimit}；最近一小时采集 ${usage.runsLastHour} / ${usage.runsPerHour} 次${usage.runsPerHour === 0 ? "（本站已停用采集）" : ""}${full ? "；来源已达上限，不能新建" : ""}</p>`;
  const taskFilter = `<option value="">全部状态</option>${Object.entries(taskStatusLabels).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}`;
  workspace.innerHTML = `<a href="#site/${encodeURIComponent(site)}">← 站点配置</a><span class="eyebrow"> / COLLECTORS</span><h1>垂直采集 · ${escape(site)}</h1><p class="muted">只采集公开 RSS/Atom、npm 官方搜索或受控 JSON；候选必须人工接受，接受后只创建草稿，不会自动发布。</p>${quota}${accessNote(manage, review)}${manage ? `<section class="panel"><h2>新建来源</h2><div class="split"><div><label for="collector-kind">类型</label><select id="collector-kind"><option value="rss">RSS / Atom</option><option value="npm">npm 搜索</option><option value="json">通用 JSON</option></select><label for="collector-config">配置 JSON</label><textarea id="collector-config" spellcheck="false">${escape(JSON.stringify(defaults.rss, null, 2))}</textarea></div><div><label for="collector-interval">间隔（秒）</label><input id="collector-interval" type="number" min="3600" max="604800" value="86400"><label><input id="collector-enabled" type="checkbox" checked>启用并参与定时采集</label></div></div><div class="actions"><button id="save-collector"${full ? " disabled" : ""}>保存来源</button><button id="refresh-collectors" class="secondary">刷新</button></div></section>` : '<div class="actions"><button id="refresh-collectors" class="secondary">刷新</button></div>'}<section class="panel"><h2>来源 ${usage.sources} / ${usage.sourceLimit}</h2><div class="table-wrap"><table><thead><tr><th>类型</th><th>配置</th><th>状态</th><th>版本</th><th>操作</th></tr></thead><tbody>${sources.map((s) => `<tr><td>${escape(s.kind)}</td><td><code>${escape(JSON.stringify(s.config))}</code></td><td>${s.enabled ? "启用" : "停用"}<br><span class="muted">每 ${escape(Math.round((s.interval_seconds / 3600) * 100) / 100)} 小时</span></td><td>${s.version}</td><td>${s.kind === "github" ? `<a class="manage-github" href="#github">在“开源项目”页管理</a>` : manage ? `<button class="secondary sync-collector" data-id="${s.id}">立即同步</button><button class="secondary edit-collector" data-id="${s.id}">编辑</button><button class="secondary detail-collector" data-id="${s.id}">候选历史</button>` : '<span class="muted">—</span>'}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">还没有采集来源。</td></tr>'}</tbody></table></div></section><section class="panel" id="collector-edit" hidden></section><section class="panel" id="collector-tasks"><h2>采集任务</h2><div class="actions"><label for="task-status">状态</label><select id="task-status">${taskFilter}</select><button id="task-prev" class="secondary" disabled>上一页</button><span id="task-page">第 1 页</span><button id="task-next" class="secondary"${tasks.hasMore ? "" : " disabled"}>下一页</button></div><div class="table-wrap"><table><thead><tr><th>状态</th><th>来源</th><th>尝试</th><th>错误 / 结果</th><th>时间</th><th>操作</th></tr></thead><tbody>${taskRows(tasks.items, manage)}</tbody></table></div></section><section class="panel" id="collector-candidates"><h2>待审核候选 ${candidates.length}</h2>${review ? `<div class="actions"><label><input id="select-all-candidates" type="checkbox"${candidates.length ? "" : " disabled"}>全选</label><button id="batch-accept" disabled>批量接受为草稿</button><button id="batch-reject" class="secondary" disabled>批量拒绝</button></div>` : ""}<div id="collector-batch-result" hidden></div><div class="table-wrap"><table><thead><tr><th></th><th>标题 / URL</th><th>语言</th><th>类型</th><th>操作</th></tr></thead><tbody>${candidates.map((c) => `<tr><td>${review ? `<input type="checkbox" class="candidate-check" data-id="${c.id}" data-version="${c.version}" data-title="${escape(c.data?.translations?.[c.locale]?.title || c.data?.url || c.id)}" aria-label="选择候选">` : ""}</td><td><strong>${escape(c.data?.translations?.[c.locale]?.title)}</strong><br><span class="muted">${escape(c.data?.url)}</span></td><td>${escape(c.locale)}</td><td>${escape(c.kind)}</td><td>${review ? `<button class="accept-collector" data-id="${c.id}" data-version="${c.version}">接受为草稿</button><button class="secondary reject-collector" data-id="${c.id}" data-version="${c.version}">拒绝</button>` : '<span class="muted">—</span>'}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">暂无待审核候选。</td></tr>'}</tbody></table></div></section><section class="panel" id="collector-history" hidden><h2>候选历史</h2><div class="table-wrap"><table><thead><tr><th>标题 / URL</th><th>外部 ID</th><th>状态</th><th>时间</th></tr></thead><tbody></tbody></table></div></section>`;
  const kind = workspace.querySelector("#collector-kind"),
    config = workspace.querySelector("#collector-config");
  kind?.addEventListener("change", () => {
    config.value = JSON.stringify(defaults[kind.value], null, 2);
  });
  workspace.querySelector("#refresh-collectors").addEventListener("click", () =>
    rerender(),
  );
  workspace.querySelector("#save-collector")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api("/collectors", {
        siteId: site,
        kind: kind.value,
        config: JSON.parse(config.value),
        enabled: workspace.querySelector("#collector-enabled").checked,
        intervalSeconds: Number(workspace.querySelector("#collector-interval").value),
        expectedVersion: 0,
      });
      await rerender();
      notice("采集来源已保存。");
    } catch (error) {
      notice(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  for (const button of workspace.querySelectorAll(".sync-collector"))
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api("/collectors/" + encodeURIComponent(button.dataset.id) + "/sync", {
          operationId: crypto.randomUUID(),
        });
        notice("已排队；Worker 运行后刷新候选。");
      } catch (error) {
        notice(error.message, true);
      } finally {
        button.disabled = false;
      }
    });
  // Source editing. The form keeps the user's input on any error, including a
  // version conflict, so nothing typed is lost.
  const editPanel = workspace.querySelector("#collector-edit");
  for (const button of workspace.querySelectorAll(".edit-collector"))
    button.addEventListener("click", () => {
      const source = sources.find((s) => s.id === button.dataset.id);
      if (!source) return;
      editPanel.innerHTML = editForm(source);
      editPanel.hidden = false;
      const initialHours = Number(editPanel.querySelector("#edit-interval").value);
      editPanel.querySelector("#cancel-edit").addEventListener("click", () => {
        editPanel.hidden = true;
        editPanel.innerHTML = "";
      });
      editPanel.querySelector("#save-edit").addEventListener("click", async (event) => {
        const save = event.currentTarget;
        const hours = Number(editPanel.querySelector("#edit-interval").value);
        if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
          notice("同步间隔必须是 1 到 168 之间的整数小时。", true);
          return;
        }
        const next = { ...source.config };
        for (const input of editPanel.querySelectorAll(".edit-config"))
          next[input.dataset.key] = input.value.trim();
        next.locale = editPanel.querySelector("#edit-locale").value;
        save.disabled = true;
        try {
          await api("/collectors", {
            id: source.id,
            siteId: site,
            kind: source.kind,
            config: next,
            enabled: editPanel.querySelector("#edit-enabled").checked,
            // Keep a legacy non-hour interval unless the user changed the field.
            intervalSeconds:
              hours === initialHours && source.interval_seconds % 3600 !== 0
                ? source.interval_seconds
                : hours * 3600,
            expectedVersion: source.version,
          });
          await rerender();
          notice("来源已更新。");
        } catch (error) {
          save.disabled = false;
          notice(
            /版本已改变/.test(error.message)
              ? "保存失败：该来源已被其他人修改（版本冲突）。你的输入仍保留在表单中；请先复制需要的内容，再点击“刷新”载入最新版本后重新编辑。"
              : error.message,
            true,
          );
        }
      });
    });
  // Task list with status filter and paging; only the table body is replaced.
  const taskPanel = workspace.querySelector("#collector-tasks");
  let taskPage = 1;
  const loadTasks = async () => {
    const status = taskPanel.querySelector("#task-status").value;
    const prev = taskPanel.querySelector("#task-prev"),
      next = taskPanel.querySelector("#task-next");
    prev.disabled = next.disabled = true;
    try {
      const result = await api(
        "/collectors/tasks?" +
          new URLSearchParams({
            site,
            page: String(taskPage),
            ...(status ? { status } : {}),
          }).toString(),
      );
      taskPanel.querySelector("tbody").innerHTML = taskRows(result.items, manage);
      taskPanel.querySelector("#task-page").textContent = `第 ${result.page} 页`;
      prev.disabled = result.page <= 1;
      next.disabled = !result.hasMore;
    } catch (error) {
      prev.disabled = taskPage <= 1;
      next.disabled = false;
      notice(error.message, true);
    }
  };
  taskPanel.querySelector("#task-status").addEventListener("change", () => {
    taskPage = 1;
    void loadTasks();
  });
  taskPanel.querySelector("#task-prev").addEventListener("click", () => {
    taskPage = Math.max(1, taskPage - 1);
    void loadTasks();
  });
  taskPanel.querySelector("#task-next").addEventListener("click", () => {
    taskPage += 1;
    void loadTasks();
  });
  taskPanel.addEventListener("click", async (event) => {
    const button = event.target.closest?.(".retry-task");
    if (!button) return;
    const id = button.dataset.id;
    let operationId = retryOperations.get(id);
    if (!operationId) {
      operationId = crypto.randomUUID();
      retryOperations.set(id, operationId);
    }
    button.disabled = true;
    try {
      await api("/collectors/tasks/" + encodeURIComponent(id) + "/retry", {
        site,
        operationId,
      });
      retryOperations.delete(id);
      notice("已重新排队；Worker 运行后刷新任务列表。");
      await loadTasks();
    } catch (error) {
      // A server answer means the request was decided; a new click is a new
      // operation. Network failures keep the id for an idempotent replay.
      if (!uncertain(error)) retryOperations.delete(id);
      button.disabled = false;
      notice(
        uncertain(error)
          ? "网络错误，重试请求可能未送达；再次点击“重试”会安全地重发同一请求。"
          : error.message,
        true,
      );
    }
  });
  for (const button of workspace.querySelectorAll(".detail-collector"))
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const detail = await api(
          "/collectors/" + encodeURIComponent(button.dataset.id),
        );
        const history = workspace.querySelector("#collector-history");
        history.querySelector("tbody").innerHTML = candidateRows(
          detail.candidates || [],
        );
        history.hidden = false;
      } catch (error) {
        notice(error.message, true);
      } finally {
        button.disabled = false;
      }
    });
  for (const button of workspace.querySelectorAll(".accept-collector, .reject-collector"))
    button.addEventListener("click", async () => {
      button.disabled = true;
      const accept = button.classList.contains("accept-collector");
      try {
        const result = await api(
          "/collector-candidates/" + encodeURIComponent(button.dataset.id) + "/review",
          {
            site,
            decision: accept ? "accept" : "reject",
            expectedVersion: Number(button.dataset.version),
          },
        );
        notice(
          accept
            ? "已接受并创建草稿：" + (result.resourceId || "")
            : "候选已拒绝。",
        );
        await rerender();
      } catch (error) {
        notice(error.message, true);
        button.disabled = false;
      }
    });
  // Batch review: each item is reviewed separately on the server, so the
  // summary reports successes and failures item by item.
  const candidatePanel = workspace.querySelector("#collector-candidates");
  const checks = [...candidatePanel.querySelectorAll(".candidate-check")];
  const selectAll = candidatePanel.querySelector("#select-all-candidates");
  if (!selectAll) return;
  const batchButtons = [
    candidatePanel.querySelector("#batch-accept"),
    candidatePanel.querySelector("#batch-reject"),
  ];
  let batchPending = false;
  const syncBatch = () => {
    const selected = checks.filter((check) => check.checked).length;
    for (const button of batchButtons) button.disabled = batchPending || !selected;
    selectAll.checked = !!checks.length && selected === checks.length;
    selectAll.indeterminate = selected > 0 && selected < checks.length;
  };
  selectAll.addEventListener("change", () => {
    for (const check of checks) check.checked = selectAll.checked;
    syncBatch();
  });
  for (const check of checks) check.addEventListener("change", syncBatch);
  for (const button of batchButtons)
    button.addEventListener("click", async () => {
      const selected = checks.filter((check) => check.checked);
      if (!selected.length) return;
      const decision = button.id === "batch-accept" ? "accept" : "reject";
      const titles = new Map(selected.map((check) => [check.dataset.id, check.dataset.title]));
      batchPending = true;
      selectAll.disabled = true;
      for (const check of checks) check.disabled = true;
      syncBatch();
      try {
        const result = await api("/collector-candidates/batch-review", {
          site,
          decision,
          items: selected.map((check) => ({
            id: check.dataset.id,
            expectedVersion: Number(check.dataset.version),
          })),
        });
        const ok = result.accepted + result.rejected;
        const summary = `${decision === "accept" ? "批量接受为草稿" : "批量拒绝"}：成功 ${ok} 条，失败 ${result.failed} 条`;
        const failures = result.results.filter((item) => !item.ok);
        await rerender();
        const box = workspace.querySelector("#collector-batch-result");
        if (box) {
          box.innerHTML = `<p><strong>${escape(summary)}</strong></p>${failures.length ? `<ul>${failures.map((item) => `<li>${escape(titles.get(item.id) || item.id)}：${escape(item.error)}</li>`).join("")}</ul>` : ""}`;
          box.hidden = false;
        }
        notice(summary + (failures.length ? "；失败明细见候选列表上方。" : "。"), failures.length > 0);
      } catch (error) {
        batchPending = false;
        selectAll.disabled = !checks.length;
        for (const check of checks) check.disabled = false;
        syncBatch();
        notice(error.message, true);
      }
    });
}
