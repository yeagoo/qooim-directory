// M18 admin views: site personas and unified distribution of one resource.
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const time = (value) => (value ? new Date(value).toLocaleString("zh-CN") : "—");
const lines = (value) =>
  String(value ?? "")
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean);
const stateLabels = {
  queued: "排队中",
  generating: "生成中",
  awaiting_input: "等待粘贴",
  review: "待审核",
  scheduled: "已排期",
  published: "已发布",
  failed: "失败",
  skipped: "已跳过",
  cancelled: "已取消",
};
// Semantic status colors shared across the console (see .status in network.css).
const stateTone = {
  queued: "run",
  generating: "run",
  awaiting_input: "review",
  review: "review",
  scheduled: "",
  published: "ok",
  failed: "fail",
  skipped: "",
  cancelled: "",
};
const stateChip = (state) =>
  `<span class="status ${stateTone[state] ?? ""}">${escape(stateLabels[state] || state)}</span>`;
const reasonLabels = {
  new_url: "出现资料外网址",
  link: "含链接",
  name_missing: "标题未提到产品名",
  content_missing: "缺少本站正文",
  structure: "未按 persona 结构",
  email: "出现邮箱",
  new_number: "出现资料外数字",
  price: "出现价格",
  html: "含 HTML",
  h1: "含一级标题",
  image: "含图片",
  first_hand: "声称亲测",
  banned: "含禁用词",
  required_missing: "缺必用词",
  too_long: "超出篇幅",
  seo_length: "SEO 长度超限",
  duplicate: "与其他站点重复",
  similar: "与其他站点相似",
  source_changed: "源数据已更新",
  draft_conflict: "已有人工草稿",
  slug_conflict: "slug 冲突",
  invalid_candidate: "草稿字段无效",
  manual: "手动粘贴",
  missed: "错过发布时间",
  conflict: "版本冲突",
  forbidden: "权限已变更",
  budget: "AI 预算不足",
  ai_disabled: "本站未启用 AI",
  site_disabled: "站点已停用",
  module_disabled: "模块未启用",
  locale_disabled: "语言未启用",
  resource_private: "资源未公开",
  translation_missing: "缺该语言主档",
};
const reason = (code) => reasonLabels[code] || code;

// --- Persona -----------------------------------------------------------------------
export async function renderPersona(site, workspace, api, notice, access) {
  const data = await api("/personas/" + encodeURIComponent(site));
  let version = data.version;
  const field = (id, label, value, hint = "") =>
    `<label for="${id}">${label}</label><input id="${id}" value="${escape(value)}"${access.write ? "" : " disabled"}>${hint ? `<small>${hint}</small>` : ""}`;
  const list = (id, label, value, hint) =>
    `<label for="${id}">${label}</label><textarea id="${id}" class="short"${access.write ? "" : " disabled"}>${escape(value.join("\n"))}</textarea><small>${hint}</small>`;
  const fill = (p) => {
    for (const key of ["positioning", "audience", "tone"])
      workspace.querySelector("#persona-" + key).value = p[key] ?? "";
    for (const key of ["focus", "structure", "banned", "required"])
      workspace.querySelector("#persona-" + key).value = (p[key] ?? []).join("\n");
    workspace.querySelector("#persona-length").value = p.length ?? "medium";
    workspace.querySelector("#persona-locale").value = p.defaultLocale ?? "zh";
    workspace.querySelector("#persona-examples").value = (p.examples ?? []).join("\n---\n");
  };
  const p = data.persona;
  workspace.innerHTML = `<a href="#site/${encodeURIComponent(site)}">← 站点设置</a><span class="eyebrow">写作 persona</span><h1>${escape(site)} 的写作方向</h1><p class="muted">统一分发时，AI 按这里的定位、读者和语气为本站单独写一版介绍。事实只取自资源主档；persona 只决定写法。</p>${
    access.write
      ? `<div class="actions">${Object.entries(data.presets)
          .map(
            ([id, preset]) =>
              `<button class="secondary persona-preset" data-preset="${escape(id)}">套用「${escape(preset.label)}」</button>`,
          )
          .join("")}</div>`
      : ""
  }<section class="panel"><div class="split"><div>${field("persona-positioning", "站点定位", p.positioning, "例如：面向独立开发者的 AI 工具导航")}${field("persona-audience", "目标读者", p.audience)}${field("persona-tone", "语气", p.tone, "例如：专业克制 / 轻松口语 / 评测风")}<label for="persona-length">篇幅</label><select id="persona-length"${access.write ? "" : " disabled"}><option value="short">短</option><option value="medium">中</option><option value="long">长</option></select><label for="persona-locale">默认语言</label><select id="persona-locale"${access.write ? "" : " disabled"}><option value="zh">中文</option><option value="en">English</option></select></div><div>${list("persona-focus", "侧重点", p.focus, "每行一项，最多 8 项")}${list("persona-structure", "介绍结构（二级标题顺序）", p.structure, "每行一个小标题，最多 8 个")}${list("persona-banned", "禁用词", p.banned, "每行一个；出现即转人工审核")}${list("persona-required", "必用词", p.required, "每行一个；缺少即转人工审核")}</div></div><label for="persona-examples">示例文案（可选）</label><textarea id="persona-examples"${access.write ? "" : " disabled"}>${escape(p.examples.join("\n---\n"))}</textarea><small>最多 2 段，用单独一行 --- 分隔。只用来示范语气，AI 不会照抄；查重也会对比它们。不能包含网址。</small>${access.write ? '<div class="actions"><button id="persona-save">保存 persona</button></div>' : ""}<p class="muted" id="persona-meta">版本 ${version}${data.updatedAt ? " · 更新于 " + escape(time(data.updatedAt)) : " · 尚未设置"}</p></section>`;
  fill(p);
  for (const button of workspace.querySelectorAll(".persona-preset"))
    button.addEventListener("click", () => {
      fill(data.presets[button.dataset.preset].persona);
      notice("已填入预设，确认后点击保存。");
    });
  workspace.querySelector("#persona-save")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const value = (id) => workspace.querySelector("#persona-" + id).value;
      const saved = await api("/personas/" + encodeURIComponent(site), {
        expectedVersion: version,
        persona: {
          positioning: value("positioning"),
          audience: value("audience"),
          tone: value("tone"),
          focus: lines(value("focus")),
          structure: lines(value("structure")),
          banned: lines(value("banned")),
          required: lines(value("required")),
          length: value("length"),
          defaultLocale: value("locale"),
          examples: value("examples")
            .split(/\n-{3,}\n/)
            .map((v) => v.trim())
            .filter(Boolean),
        },
      });
      version = saved.version;
      workspace.querySelector("#persona-meta").textContent = `版本 ${version} · 已保存`;
      notice("persona 已保存。新的分发任务会使用它；已发布内容不会自动改写。");
    } catch (error) {
      notice(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

// --- Distribution ------------------------------------------------------------------
function cell(value, locale, site) {
  if (!site.locales.includes(locale)) return '<span class="muted">未启用</span>';
  const parts = [];
  const pub = value.publication;
  if (pub)
    parts.push(
      `<span class="badge">${pub.status === "published" ? "已发布" : "已下线"} v${pub.version}</span>${pub.source === "stale" ? ' <span class="badge stale">源已更新</span>' : pub.source === "unknown" ? ' <span class="muted">来源版本未知</span>' : ""}`,
    );
  if (value.draft?.pending) parts.push('<span class="badge">有草稿</span>');
  if (value.schedule) parts.push(`<small>排期 ${escape(time(value.schedule.publishAt))}</small>`);
  // Scheduling acts on the pair's current draft; the server rechecks both versions.
  if (site.write && value.draft?.pending) {
    const data = `data-site="${escape(site.id)}" data-locale="${locale}" data-published="${pub?.version ?? 0}" data-draft="${value.draft.version}"`;
    parts.push(
      `<span class="row"><input type="datetime-local" class="sched-at" ${data} aria-label="${escape(site.id)} ${locale} 发布时间"><button class="secondary sched-set" ${data}>设定排期</button>${value.schedule ? `<button class="secondary sched-clear" ${data}>取消排期</button>` : ""}</span>`,
    );
  }
  if (value.task)
    parts.push(
      `<small>最近任务：${escape(stateLabels[value.task.state] || value.task.state)}${value.task.reasons?.length ? " · " + value.task.reasons.map(reason).map(escape).join("、") : ""}</small>`,
    );
  return parts.join("<br>") || '<span class="muted">未收录</span>';
}
function taskRow(task, write) {
  const actions = [];
  if (write) {
    if (["queued", "generating", "awaiting_input", "review", "scheduled"].includes(task.state))
      actions.push(`<button class="secondary task-action" data-action="cancel" data-id="${task.id}">取消</button>`);
    if (["failed", "skipped", "cancelled"].includes(task.state))
      actions.push(`<button class="secondary task-action" data-action="retry" data-id="${task.id}">重试</button>`);
    if (task.state === "review" && task.output)
      actions.push(`<button class="task-action" data-action="approve" data-id="${task.id}">审核通过并发布</button>`);
    if (["awaiting_input", "review", "failed"].includes(task.state))
      actions.push(`<button class="secondary task-manual" data-id="${task.id}">手动生成</button>`);
  }
  return `<tr><td>${escape(task.site)}</td><td>${escape(task.locale)}</td><td>${stateChip(task.state)}${task.error ? `<br><code>${escape(reason(task.error))}</code>` : ""}</td><td>${task.reasons.map(reason).map(escape).join("、") || "—"}</td><td>${task.similarity == null ? "—" : Math.round(task.similarity * 100) + "%"}</td><td>${escape(time(task.publishAt))}</td><td>${task.output ? `<details><summary>查看</summary><strong>${escape(task.output.title)}</strong><p>${escape(task.output.description)}</p>${task.output.content ? `<pre>${escape(task.output.content)}</pre>` : ""}</details>` : "—"}</td><td>${actions.join(" ") || "—"}</td></tr>`;
}
export async function renderDistribute(resource, workspace, api, notice, context) {
  const writable = new Set(
    context.sites.filter((s) => context.globalAdmin || s.role === "editor").map((s) => s.id),
  );
  workspace.innerHTML = `<span class="eyebrow">统一分发</span><h1>一份资料，按站点各写一版。</h1><p class="muted">选择资源与目标站点，AI 按各站 persona 生成草稿：通过事实与查重检查的按排期自动发布，其余留待审核。也可以选择手动模式，把提示词复制到网页版 ChatGPT / DeepSeek，再把 JSON 粘贴回来。</p><section class="panel"><div class="row"><label for="dist-resource">资源 ID</label><input id="dist-resource" value="${escape(resource)}" placeholder="例如 figma"><button id="dist-load">查看</button></div></section><div id="dist-body"></div>${
    context.globalAdmin
      ? `<section class="panel"><h2>本站缺少的资源</h2><div class="row"><select id="missing-site">${context.sites.map((s) => `<option value="${escape(s.id)}">${escape(s.config?.name || s.id)}</option>`).join("")}</select><button class="secondary" id="missing-load">列出</button></div><div id="missing-list"></div></section>`
      : ""
  }`;
  const body = workspace.querySelector("#dist-body");
  const load = async () => {
    const id = workspace.querySelector("#dist-resource").value.trim();
    if (!id) return;
    if (location.hash !== "#distribute/" + encodeURIComponent(id))
      history.replaceState(null, "", "#distribute/" + encodeURIComponent(id));
    const [matrix, distributions] = await Promise.all([
      api("/distribution/matrix?resource=" + encodeURIComponent(id)),
      api("/distributions?resource=" + encodeURIComponent(id)),
    ]);
    const published = [];
    for (const site of matrix.sites)
      for (const locale of ["zh", "en"]) {
        const pub = site.cells[locale].publication;
        if (pub?.status === "published") published.push({ site: site.id, locale, version: pub.version });
      }
    body.innerHTML = `<section class="panel"><h2>${escape(matrix.resource.id)} 在各站点</h2><p class="muted">内容版本 v${matrix.resource.contentVersion} · 主档语言 ${matrix.resource.locales.map(escape).join(" / ")} · 主站 ${escape(matrix.resource.primarySite || "未设置")}（仅用于管理，不影响 canonical）</p><div class="table-wrap"><table><thead><tr><th>选择</th><th>站点</th><th>中文</th><th>English</th><th>persona</th></tr></thead><tbody>${matrix.sites
      .map(
        (site) =>
          `<tr><td><input type="checkbox" class="dist-site" value="${escape(site.id)}"${site.write && site.active ? "" : " disabled"}></td><td>${escape(site.name || site.id)}<br><small>${escape(site.id)}</small></td><td>${cell(site.cells.zh, "zh", site)}</td><td>${cell(site.cells.en, "en", site)}</td><td>${site.persona ? "已设置" : `<a href="#persona/${encodeURIComponent(site.id)}">去设置</a>`}</td></tr>`,
      )
      .join("")}</tbody></table></div><div class="actions"><button class="secondary" id="dist-all">全选可写站点</button><button class="secondary" id="dist-stale">选中“源已更新”的站点</button></div><div class="split"><div><label>语言</label><label><input type="checkbox" class="dist-locale" value="zh" checked>中文</label><label><input type="checkbox" class="dist-locale" value="en">English</label><label for="dist-mode">生成方式</label><select id="dist-mode"><option value="ai">AI 自动（通过检查即按排期发布）</option><option value="manual">手动复制提示词（不自动发布）</option></select></div><div><label for="dist-stagger">错开发布（天）</label><input id="dist-stagger" type="number" min="0" max="30" value="0"><small>0 表示通过检查后立即发布；大于 0 时在该天数内随机错开。</small><small>已有人工草稿的站点不会被覆盖，结果会留在审核里。</small></div></div><div class="actions"><button id="dist-create">开始分发</button></div></section>${
      context.globalAdmin || published.length
        ? `<section class="panel"><h2>批量操作</h2><div class="actions">${published.length ? `<button class="secondary" id="dist-unpublish">从全部站点下线（${published.length} 处）</button>` : ""}${context.globalAdmin ? `<select id="dist-primary"><option value="">不设主站</option>${matrix.sites.map((s) => `<option value="${escape(s.id)}"${s.id === matrix.resource.primarySite ? " selected" : ""}>${escape(s.name || s.id)}</option>`).join("")}</select><button class="secondary" id="dist-primary-save">设置主站</button>` : ""}</div></section>`
        : ""
    }<section class="panel"><h2>分发记录</h2>${
      distributions.length
        ? distributions
            .map(
              (d) =>
                `<h3>${escape(time(d.createdAt))} · ${d.mode === "ai" ? "AI" : "手动"}${d.staggerDays ? ` · 错开 ${d.staggerDays} 天` : ""} · ${escape(d.createdBy || "")}</h3><div class="table-wrap"><table><thead><tr><th>站点</th><th>语言</th><th>状态</th><th>检查结果</th><th>相似度</th><th>计划发布</th><th>内容</th><th>操作</th></tr></thead><tbody>${d.tasks.map((t) => taskRow(t, writable.has(t.site))).join("")}</tbody></table></div>`,
            )
            .join("")
        : '<p class="muted">还没有分发记录。</p>'
    }</section><section class="panel" id="manual-panel" hidden><h2>手动生成</h2><p class="muted">1. 复制下面的提示词，粘贴到网页版 ChatGPT / DeepSeek。2. 把回复整段粘贴到下方（可以带 \`\`\`json 代码块）。3. 先预览检查结果，再保存为草稿。手动结果不会自动发布。</p><label for="manual-prompt">提示词</label><textarea id="manual-prompt" readonly></textarea><div class="actions"><button class="secondary" id="manual-copy">复制提示词</button></div><label for="manual-reply">AI 回复</label><textarea id="manual-reply"></textarea><label><input type="checkbox" id="manual-replace">替换站点上已有的人工草稿</label><div class="actions"><button class="secondary" id="manual-preview">预览</button><button id="manual-save">保存为草稿</button></div><div id="manual-result"></div></section>`;
    const checked = () => [...body.querySelectorAll(".dist-site:checked")].map((b) => b.value);
    body.querySelector("#dist-all").addEventListener("click", () => {
      for (const box of body.querySelectorAll(".dist-site")) box.checked = !box.disabled;
    });
    body.querySelector("#dist-stale").addEventListener("click", () => {
      for (const box of body.querySelectorAll(".dist-site")) {
        const site = matrix.sites.find((s) => s.id === box.value);
        box.checked =
          !box.disabled &&
          ["zh", "en"].some((l) => site.cells[l].publication?.source === "stale");
      }
    });
    const act = (selector, fn) =>
      body.querySelector(selector)?.addEventListener("click", async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await fn(button);
        } catch (error) {
          notice(error.message, true);
        } finally {
          button.disabled = false;
        }
      });
    act("#dist-create", async () => {
      const locales = [...body.querySelectorAll(".dist-locale:checked")].map((b) => b.value);
      const sites = checked();
      if (!sites.length || !locales.length) throw new Error("请选择至少一个站点和一种语言");
      // Only languages the site has enabled; the server skips anything else with a reason.
      const targets = sites.flatMap((site) =>
        locales
          .filter((l) => matrix.sites.find((s) => s.id === site).locales.includes(l))
          .map((locale) => ({ site, locale })),
      );
      if (!targets.length) throw new Error("所选站点都没有启用所选语言");
      const result = await api("/distributions", {
        resourceId: matrix.resource.id,
        targets,
        mode: body.querySelector("#dist-mode").value,
        staggerDays: Number(body.querySelector("#dist-stagger").value || 0),
      });
      const skipped = result.tasks.filter((t) => t.state === "skipped");
      notice(
        `已创建 ${result.tasks.length} 个任务${skipped.length ? `，其中 ${skipped.length} 个已跳过：` + skipped.map((t) => `${t.site}/${t.locale} ${reason(t.error)}`).join("；") : ""}。`,
        Boolean(skipped.length),
      );
      await load();
    });
    act("#dist-unpublish", async () => {
      if (!confirm(`确认从 ${published.length} 处全部下线？要么全部成功，要么都不改变。`)) return;
      await api("/distribution/unpublish", { resourceId: matrix.resource.id, expected: published });
      notice("已从全部站点下线。");
      await load();
    });
    act("#dist-primary-save", async () => {
      await api("/distribution/primary", {
        resourceId: matrix.resource.id,
        site: body.querySelector("#dist-primary").value || null,
      });
      notice("主站已更新。");
      await load();
    });
    for (const button of body.querySelectorAll(".sched-set,.sched-clear"))
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const d = button.dataset;
          let publishAt = null;
          if (button.classList.contains("sched-set")) {
            const input = body.querySelector(
              `.sched-at[data-site="${CSS.escape(d.site)}"][data-locale="${d.locale}"]`,
            );
            if (!input.value) throw new Error("请选择发布时间");
            publishAt = new Date(input.value).toISOString();
          }
          await api("/schedules", {
            site: d.site,
            resourceId: matrix.resource.id,
            locale: d.locale,
            publishAt,
            expected: { published: Number(d.published), draft: Number(d.draft) },
          });
          notice(publishAt ? "已设定排期。" : "已取消排期。");
          await load();
        } catch (error) {
          notice(error.message, true);
        } finally {
          button.disabled = false;
        }
      });
    for (const button of body.querySelectorAll(".task-action"))
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const action = button.dataset.action;
          let payload = {};
          if (action === "approve") {
            try {
              await api(`/distribution-tasks/${button.dataset.id}/approve`, payload);
            } catch (error) {
              if (error.status !== 409 || !/人工草稿/.test(error.message)) throw error;
              if (!confirm(error.message + "\n确认替换并发布？")) return;
              payload = { replaceDraft: true };
              await api(`/distribution-tasks/${button.dataset.id}/approve`, payload);
            }
          } else await api(`/distribution-tasks/${button.dataset.id}/${action}`, payload);
          notice("操作完成。");
          await load();
        } catch (error) {
          notice(error.message, true);
        } finally {
          button.disabled = false;
        }
      });
    let manualTask = null;
    const panel = body.querySelector("#manual-panel");
    for (const button of body.querySelectorAll(".task-manual"))
      button.addEventListener("click", async () => {
        try {
          const prompt = await api(`/distribution-tasks/${button.dataset.id}/prompt`);
          manualTask = button.dataset.id;
          panel.hidden = false;
          panel.querySelector("h2").textContent = `手动生成 · ${prompt.site} / ${prompt.locale}`;
          panel.querySelector("#manual-prompt").value = prompt.text;
          panel.querySelector("#manual-reply").value = "";
          previewToken = null;
          save.disabled = true;
          panel.querySelector("#manual-result").innerHTML = "";
          panel.scrollIntoView({ behavior: "smooth" });
        } catch (error) {
          notice(error.message, true);
        }
      });
    act("#manual-copy", async () => {
      const text = panel.querySelector("#manual-prompt").value;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        panel.querySelector("#manual-prompt").select();
        document.execCommand("copy");
      }
      notice("提示词已复制。");
    });
    let previewToken = null;
    const save = panel.querySelector("#manual-save");
    save.disabled = true;
    // Any edit of the reply needs a fresh preview before it can be saved.
    panel.querySelector("#manual-reply").addEventListener("input", () => {
      previewToken = null;
      save.disabled = true;
    });
    const paste = async (confirm) => {
      if (!manualTask) throw new Error("请先选择任务");
      const result = await api(`/distribution-tasks/${manualTask}/paste`, {
        text: panel.querySelector("#manual-reply").value,
        confirm,
        ...(confirm ? { previewToken } : {}),
        replaceDraft: panel.querySelector("#manual-replace").checked,
      });
      if (!confirm) previewToken = result.previewToken;
      panel.querySelector("#manual-result").innerHTML = `<div class="notice${result.reasons.length ? " error" : ""}">${result.reasons.length ? "需要人工留意：" + result.reasons.map(reason).map(escape).join("、") : "检查通过"} · 相似度 ${Math.round(result.similarity * 100)}%</div><h3>${escape(result.output.title)}</h3><p>${escape(result.output.description)}</p>${result.output.tagline ? `<p class="muted">${escape(result.output.tagline)}</p>` : ""}${result.output.content ? `<pre>${escape(result.output.content)}</pre>` : ""}`;
      return result;
    };
    body.querySelector("#manual-preview").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await paste(false);
        save.disabled = false;
      } catch (error) {
        notice(error.message, true);
      } finally {
        button.disabled = false;
      }
    });
    act("#manual-save", async () => {
      if (!previewToken) throw new Error("请先预览");
      await paste(true);
      notice("已保存为草稿，审核后可发布。");
      await load();
    });
  };
  const bindLoad = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await load();
    } catch (error) {
      notice(error.message, true);
    } finally {
      button.disabled = false;
    }
  };
  workspace.querySelector("#dist-load").addEventListener("click", bindLoad);
  workspace.querySelector("#missing-load")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const rows = await api(
        "/distribution/missing?site=" + encodeURIComponent(workspace.querySelector("#missing-site").value),
      );
      workspace.querySelector("#missing-list").innerHTML = rows.length
        ? `<div class="table-wrap"><table><thead><tr><th>资源</th><th>已发布站点数</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td>${escape(r.title)}<br><small>${escape(r.id)}</small></td><td>${r.sites}</td><td><a href="#distribute/${encodeURIComponent(r.id)}">去分发</a></td></tr>`).join("")}</tbody></table></div>`
        : '<p class="muted">本站已收录全部公开资源。</p>';
    } catch (error) {
      notice(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  if (resource) await load();
}
