const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const renders = new WeakMap();
export function cancelGithubRender(root) {
  renders.delete(root);
  root.inert = false;
  root.removeAttribute("aria-busy");
}
export async function renderGithub(
  root,
  api,
  notice,
  sites,
  selectedId = null,
  page = 1,
  local = {},
) {
  const token = Symbol("github-render");
  renders.set(root, token);
  root.inert = true;
  root.setAttribute("aria-busy", "true");
  let sources, detail;
  try {
    sources = await api("/github/sources?page=" + page);
    detail = selectedId ? await api("/github/sources/" + selectedId) : null;
  } catch (error) {
    if (renders.get(root) === token) cancelGithubRender(root);
    throw error;
  }
  if (renders.get(root) !== token) return;
  if (location.hash !== "#github") {
    cancelGithubRender(root);
    return;
  }
  root.inert = false;
  root.removeAttribute("aria-busy");
  const selected = detail?.source;
  root.innerHTML = `<span class="eyebrow">开源项目 / GitHub</span><h1>发现项目，保留判断。</h1><p class="muted">只同步公开仓库资料。先比较候选，再更新共享主档；各站选择新版并发布后才更新线上。</p><div class="actions"><button class="secondary" id="github-reload">重新读取</button><button class="secondary" id="github-load-source">放弃本页来源编辑并重新载入</button></div><p id="source-editor-state" class="muted"></p><div class="split"><section class="panel"><h2>GitHub 来源</h2><div class="table-wrap github-sources"><table><tr><th>仓库</th><th>站点 / 状态</th><th>操作</th></tr>${sources.map((s) => `<tr><td>${escape(s.repository)}</td><td>${escape(s.site_id)} · ${s.enabled && s.site_active && s.module_enabled ? "运行" : "暂停"}</td><td><button class="secondary source-edit" data-id="${escape(s.id)}">查看</button></td></tr>`).join("")}</table></div><div class="actions">${page > 1 ? '<button class="secondary" id="source-prev">上一页</button>' : ""}${sources.length === 50 ? '<button class="secondary" id="source-next">下一页</button>' : ""}<button class="secondary" id="source-new">新增来源</button></div></section><section class="panel"><h2>${selected ? "编辑来源" : "新增来源"}</h2><label for="github-site">采集所属站点</label><select id="github-site" ${selected ? "disabled" : ""}>${sites.map((s) => `<option value="${escape(s.id)}">${escape(s.config.name)} · ${escape(s.id)}</option>`).join("")}</select><label for="github-resource">资源标识（新建或绑定已有主档）</label><input id="github-resource" value="${escape(selected?.resource_id)}" ${selected ? "readonly" : ""}><label for="github-repository">GitHub 仓库（owner/repo）</label><input id="github-repository" placeholder="owner/repository" value="${escape(selected?.repository)}"><label for="github-interval">同步间隔（小时，1–168）</label><input id="github-interval" type="number" min="1" max="168" value="${(selected?.interval_seconds ?? 86400) / 3600}"><label><input type="checkbox" id="github-enabled" ${selected?.enabled !== false ? "checked" : ""}>启用来源</label><p class="muted">先在站点配置启用“开源项目模块”。停用会保留资料与历史；重新启用需重新同步审核。</p><div class="actions"><button id="source-save">保存来源</button>${selected ? '<button class="secondary" id="source-sync">立即同步</button>' : ""}${selected ? `<a id="source-content-link" href="#content/${encodeURIComponent(selected.site_id)}">管理本站发布 →</a>` : ""}</div></section></div><section id="github-review"></section>${detail ? `<section class="panel"><h2>最近任务</h2><p class="muted">暂停来源或模块不会发起新采集；来源变更会取消旧任务。失败后可重新发起同步。</p><div class="table-wrap"><table><tr><th>状态</th><th>尝试</th><th>结果 / 错误</th></tr>${detail.tasks.map((t) => `<tr><td>${escape(t.status)}</td><td>${t.attempts}/5</td><td>${escape(t.result ?? t.error_code ?? "等待处理")}</td></tr>`).join("")}</table></div></section>` : ""}`;
  if (selected) root.querySelector("#github-site").value = selected.site_id;
  const editor = () => ({
    siteId: root.querySelector("#github-site").value,
    resourceId: root.querySelector("#github-resource").value,
    repository: root.querySelector("#github-repository").value,
    intervalSeconds:
      Number(root.querySelector("#github-interval").value) * 3600,
    enabled: root.querySelector("#github-enabled").checked,
  });
  const baseline = editor();
  const expectedVersion =
    local.sourceDraft?.expectedVersion ?? selected?.version ?? 0;
  if (local.sourceDraft) {
    const draft = local.sourceDraft;
    for (const [id, key] of [
      ["site", "siteId"],
      ["resource", "resourceId"],
      ["repository", "repository"],
    ])
      root.querySelector("#github-" + id).value = draft[key];
    root.querySelector("#github-interval").value = draft.intervalSeconds / 3600;
    root.querySelector("#github-enabled").checked = draft.enabled;
    root.querySelector("#source-editor-state").textContent =
      `保留未保存编辑（版本 ${expectedVersion}）；服务器版本 ${selected?.version ?? 0}。可放弃本页编辑后重新载入。`;
  }
  let pending = false,
    committed = false,
    confirmation = "",
    reloadId = selectedId;
  const anchor = root.querySelector("#github-reload");
  const active = () => root.contains(anchor) && location.hash === "#github";
  const disabled = new Map();
  const lock = () => {
    for (const control of root.querySelectorAll("button,input,select")) {
      if (!disabled.has(control)) disabled.set(control, control.disabled);
      control.disabled = true;
    }
  };
  const unlock = () => {
    for (const [control, original] of disabled) control.disabled = original;
    disabled.clear();
    if (committed) {
      lock();
      anchor.disabled = false;
      root.querySelector("#github-load-source").disabled = false;
    }
  };
  const snapshot = () => {
    const value = editor();
    const candidate = detail?.candidates.find(
      (c) => c.id === root.querySelector("#github-candidate")?.value,
    );
    return {
      sourceDraft:
        local.sourceDraft || JSON.stringify(value) !== JSON.stringify(baseline)
          ? { ...value, expectedVersion }
          : undefined,
      cursor: candidate
        ? {
            id: candidate.id,
            version: candidate.version,
            sourceVersion: selected.version,
            resourceVersion: detail.current?.version ?? 0,
            fields: [...root.querySelectorAll(".github-field:checked")].map(
              (i) => i.value,
            ),
          }
        : undefined,
    };
  };
  const refresh = async (discard = false) => {
    const state = discard ? {} : snapshot();
    if (committed && local.clearCursor) delete state.cursor;
    await renderGithub(root, api, notice, sites, reloadId, page, state);
    if (confirmation && location.hash === "#github" && !root.contains(anchor))
      notice(confirmation);
  };
  const bind = (id, fn, read = false) =>
    root.querySelector("#" + id)?.addEventListener("click", async (event) => {
      if (
        !active() ||
        pending ||
        event.currentTarget.disabled ||
        (committed && !read)
      )
        return;
      pending = true;
      lock();
      try {
        await fn();
      } catch (error) {
        if (active())
          notice(
            confirmation
              ? `${confirmation} 刷新失败：${error.message}；请重新读取。`
              : error.message,
            true,
          );
      } finally {
        pending = false;
        if (active()) unlock();
      }
    });
  const acknowledge = (text, id, clearDraft = false, clearCursor = false) => {
    committed = true;
    confirmation = text;
    reloadId = id;
    if (clearDraft) {
      local.sourceDraft = undefined;
      Object.assign(baseline, editor());
    }
    local.clearCursor = clearCursor;
    notice(text);
  };
  bind("github-reload", () => refresh(), true);
  bind("github-load-source", () => refresh(true), true);
  for (const button of root.querySelectorAll(".source-edit"))
    button.addEventListener("click", () => {
      if (pending || committed || !active()) return;
      void renderGithub(
        root,
        api,
        notice,
        sites,
        button.dataset.id,
        page,
      ).catch((e) => notice(e.message, true));
    });
  bind("source-prev", () =>
    renderGithub(root, api, notice, sites, selectedId, page - 1, snapshot()),
  );
  bind("source-next", () =>
    renderGithub(root, api, notice, sites, selectedId, page + 1, snapshot()),
  );
  bind("source-new", () => renderGithub(root, api, notice, sites, null, page));
  bind("source-save", async () => {
    const result = await api("/github/sources", {
      siteId: root.querySelector("#github-site").value,
      resourceId: root.querySelector("#github-resource").value,
      repository: root.querySelector("#github-repository").value,
      intervalSeconds:
        Number(root.querySelector("#github-interval").value) * 3600,
      enabled: root.querySelector("#github-enabled").checked,
      expectedVersion,
    });
    acknowledge("来源已保存，采集只生成待审核候选。", result.id, true, true);
    await refresh();
  });
  let syncOperation = crypto.randomUUID();
  bind("source-sync", async () => {
    await api("/github/sources/" + selected.id + "/sync", {
      operationId: syncOperation,
    });
    syncOperation = crypto.randomUUID();
    acknowledge("同步已排队，Worker 处理后点击“刷新候选”。", selected.id);
    await refresh();
  });
  if (detail) {
    const panel = root.querySelector("#github-review");
    panel.innerHTML = `<section class="panel"><div class="row"><h2>同步候选</h2><button class="secondary" id="source-refresh">刷新候选</button></div><p class="muted">已发布内容不会随采集变化。默认只更新仓库元数据；新主档需选中地址、标题和说明。没有识别到许可证不代表已获得使用授权。</p><label for="github-candidate">选择候选</label><select id="github-candidate"><option value="">选择一份候选</option>${detail.candidates.map((c) => `<option value="${escape(c.id)}">${escape(c.status)} · ${escape(c.created_at)} · 主档基线 ${c.base_version}</option>`).join("")}</select><div id="candidate-material"></div></section>`;
    bind("source-refresh", () => refresh());
    panel.querySelector("#github-candidate").addEventListener("change", () => {
      if (pending || committed || !active()) return;
      const candidate = detail.candidates.find(
          (c) => c.id === panel.querySelector("#github-candidate").value,
        ),
        material = panel.querySelector("#candidate-material");
      if (!candidate) {
        material.innerHTML = "";
        return;
      }
      const fields = [
          "project",
          "url",
          "source",
          "translations.en.title",
          "translations.en.description",
        ],
        labels = [
          "仓库数据（Stars、语言、许可证等）",
          "访问地址",
          "来源标记",
          "英文标题",
          "英文说明",
        ];
      material.innerHTML = `<p>当前主档版本 ${detail.current?.version ?? 0} · 候选版本 ${candidate.version}</p><div class="split"><div><h3>当前主档</h3><pre>${escape(JSON.stringify(detail.current?.data ?? null, null, 2))}</pre></div><div><h3>同步候选</h3><pre>${escape(JSON.stringify(candidate.data, null, 2))}</pre></div></div><fieldset><legend>选择要应用的字段，未选字段保留当前人工内容</legend>${fields.map((f, i) => `<label><input type="checkbox" class="github-field" value="${f}" ${!detail.current?.data || i === 0 ? "checked" : ""}>${labels[i]}</label>`).join("")}</fieldset><div class="actions"><button id="candidate-accept" ${candidate.status !== "pending" ? "disabled" : ""}>应用所选字段到主档</button><button class="secondary" id="candidate-reject" ${candidate.status !== "pending" ? "disabled" : ""}>拒绝此候选</button><a href="#resources">编辑资源主档</a><a href="#content/${encodeURIComponent(selected.site_id)}">进入本站发布</a></div>`;
      for (const decision of ["accept", "reject"])
        bind("candidate-" + decision, async () => {
          let selectedFields = [
            ...material.querySelectorAll(".github-field:checked"),
          ].map((i) => i.value);
          if (decision === "reject" && !selectedFields.length)
            selectedFields = ["project"];
          await api("/github/review", {
            candidateId: candidate.id,
            expectedCandidateVersion: candidate.version,
            expectedResourceVersion: detail.current?.version ?? 0,
            decision,
            fields: selectedFields,
          });
          acknowledge(
            decision === "accept"
              ? "已更新主档，请到各站选择新版并发布。"
              : "已拒绝候选。",
            selected.id,
            false,
            true,
          );
          await refresh();
        });
    });
    if (local.cursor) {
      const cursor = local.cursor;
      const candidate = detail.candidates.find((c) => c.id === cursor.id);
      if (
        candidate?.status === "pending" &&
        candidate.version === cursor.version &&
        selected.version === cursor.sourceVersion &&
        (detail.current?.version ?? 0) === cursor.resourceVersion
      ) {
        const select = panel.querySelector("#github-candidate");
        select.value = cursor.id;
        select.dispatchEvent(new Event("change"));
        for (const field of panel.querySelectorAll(".github-field"))
          field.checked = cursor.fields.includes(field.value);
      } else {
        root.querySelector("#source-editor-state").textContent +=
          " 候选、来源或主档已变化，请重新选择候选并确认字段。";
      }
    }
  }
}
