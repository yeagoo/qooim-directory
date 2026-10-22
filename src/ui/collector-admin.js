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
export async function renderCollectors(site, workspace, api, notice) {
  const sources = await api("/collectors?site=" + encodeURIComponent(site));
  const candidates = await api(
    "/collector-candidates?site=" + encodeURIComponent(site),
  );
  const usage = await api("/collectors/usage?site=" + encodeURIComponent(site));
  const full = usage.sources >= usage.sourceLimit;
  const quota = `<p class="muted" id="collector-usage">来源 ${usage.sources} / ${usage.sourceLimit}；最近一小时采集 ${usage.runsLastHour} / ${usage.runsPerHour} 次${usage.runsPerHour === 0 ? "（本站已停用采集）" : ""}${full ? "；来源已达上限，不能新建" : ""}</p>`;
  workspace.innerHTML = `<a href="#site/${encodeURIComponent(site)}">← 站点配置</a><span class="eyebrow"> / COLLECTORS</span><h1>垂直采集 · ${escape(site)}</h1><p class="muted">只采集公开 RSS/Atom、npm 官方搜索或受控 JSON；候选必须人工接受，接受后只创建草稿，不会自动发布。</p>${quota}<section class="panel"><h2>新建来源</h2><div class="split"><div><label for="collector-kind">类型</label><select id="collector-kind"><option value="rss">RSS / Atom</option><option value="npm">npm 搜索</option><option value="json">通用 JSON</option></select><label for="collector-config">配置 JSON</label><textarea id="collector-config" spellcheck="false">${escape(JSON.stringify(defaults.rss, null, 2))}</textarea></div><div><label for="collector-interval">间隔（秒）</label><input id="collector-interval" type="number" min="3600" max="604800" value="86400"><label><input id="collector-enabled" type="checkbox" checked>启用并参与定时采集</label></div></div><div class="actions"><button id="save-collector"${full ? " disabled" : ""}>保存来源</button><button id="refresh-collectors" class="secondary">刷新</button></div></section><section class="panel"><h2>来源 ${usage.sources} / ${usage.sourceLimit}</h2><div class="table-wrap"><table><thead><tr><th>类型</th><th>配置</th><th>状态</th><th>版本</th><th>操作</th></tr></thead><tbody>${sources.map((s) => `<tr><td>${escape(s.kind)}</td><td><code>${escape(JSON.stringify(s.config))}</code></td><td>${s.enabled ? "启用" : "停用"}</td><td>${s.version}</td><td><button class="secondary sync-collector" data-id="${s.id}">立即同步</button><button class="secondary detail-collector" data-id="${s.id}">候选历史</button></td></tr>`).join("") || '<tr><td colspan="5" class="muted">还没有采集来源。</td></tr>'}</tbody></table></div></section><section class="panel"><h2>待审核候选 ${candidates.length}</h2><div class="table-wrap"><table><thead><tr><th>标题 / URL</th><th>语言</th><th>类型</th><th>操作</th></tr></thead><tbody>${candidates.map((c) => `<tr><td><strong>${escape(c.data?.translations?.[c.locale]?.title)}</strong><br><span class="muted">${escape(c.data?.url)}</span></td><td>${escape(c.locale)}</td><td>${escape(c.kind)}</td><td><button class="accept-collector" data-id="${c.id}" data-version="${c.version}">接受为草稿</button><button class="secondary reject-collector" data-id="${c.id}" data-version="${c.version}">拒绝</button></td></tr>`).join("") || '<tr><td colspan="4" class="muted">暂无待审核候选。</td></tr>'}</tbody></table></div></section><section class="panel" id="collector-history" hidden><h2>候选历史</h2><div class="table-wrap"><table><thead><tr><th>标题 / URL</th><th>外部 ID</th><th>状态</th><th>时间</th></tr></thead><tbody></tbody></table></div></section>`;
  const kind = workspace.querySelector("#collector-kind"),
    config = workspace.querySelector("#collector-config");
  kind.addEventListener("change", () => {
    config.value = JSON.stringify(defaults[kind.value], null, 2);
  });
  workspace.querySelector("#refresh-collectors").addEventListener("click", () =>
    renderCollectors(site, workspace, api, notice),
  );
  workspace.querySelector("#save-collector").addEventListener("click", async (event) => {
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
      await renderCollectors(site, workspace, api, notice);
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
        await renderCollectors(site, workspace, api, notice);
      } catch (error) {
        notice(error.message, true);
        button.disabled = false;
      }
    });
}
