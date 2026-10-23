const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function bind(root, id, notice, fn) {
  root.querySelector("#" + id)?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await fn();
    } catch (error) {
      notice(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}
const contentLoads = new WeakMap();
export function cancelContentRender(root) {
  contentLoads.delete(root);
}
function beginContentLoad(root) {
  const token = {};
  contentLoads.set(root, token);
  root.setAttribute("aria-busy", "true");
  const current = () => contentLoads.get(root) === token;
  return {
    current,
    finish() {
      if (current()) root.removeAttribute("aria-busy");
    },
  };
}
function editorGuard(root, selector) {
  const node = root.querySelector(selector);
  let revision = 0,
    latestRead = 0;
  return {
    change: () => {
      revision++;
    },
    start(readOnly = false) {
      const expected = revision,
        read = ++latestRead;
      return () =>
        root.querySelector(selector) === node &&
        revision === expected &&
        (!readOnly || latestRead === read);
    },
  };
}
async function guarded(current, work, accept) {
  let result;
  try {
    result = await work();
  } catch (error) {
    if (current()) throw error;
    return;
  }
  if (current()) return accept(result);
}
function resourceRows(rows) {
  return rows
    .map(
      (r) =>
        `<tr><td>${escape(r.id)}</td><td>${r.version}</td><td><button class="secondary edit-resource" data-id="${escape(r.id)}">编辑</button></td></tr>`,
    )
    .join("");
}
function publicationRows(rows, bulk = false) {
  return rows
    .map(
      (p, index) =>
        `<tr>${bulk ? `<td><input type="checkbox" class="bulk-publication" data-index="${index}" ${p.draft_version ? "" : "disabled"} aria-label="选择 ${escape(p.id)} ${escape(p.locale)}"></td>` : ""}<td>${escape(p.id)} · ${escape(p.locale)}</td><td>${escape(p.status ?? "尚未发布")} · ${p.version ?? 0}</td><td>${p.resource_version > p.source_version ? "有新版本" : "已同步"}</td><td><button class="secondary edit-publication" data-index="${index}">编辑</button></td></tr>`,
    )
    .join("");
}
function categoryButtons(rows, kind = "category") {
  return rows
    .map(
      (c) =>
        `<button class="secondary edit-${kind}" data-id="${escape(c.id)}">${escape(Object.values(c.labels)[0])}</button>`,
    )
    .join("");
}
// Editor for a flat per-site taxonomy (categories, tags); bound in renderContent.
function taxonomyPanel(kind, label, rows) {
  return `<section class="panel"><h2>本站${label}</h2><div class="actions" id="${kind}-choices">${categoryButtons(rows, kind)}</div><div class="split"><div><label for="${kind}-id">标识</label><input id="${kind}-id"><label for="${kind}-labels">名称 JSON</label><input id="${kind}-labels" value='{"zh":"新${label}"}'></div><div><label for="${kind}-rank">排序（较小的在前）</label><input id="${kind}-rank" type="number" value="0"><label><input type="checkbox" id="${kind}-active" checked>启用${label}</label></div></div><div class="actions"><button id="save-${kind}">保存${label}</button><button id="new-${kind}" class="secondary">新增${label}</button></div></section>`;
}
// Extra categories and tags of a published record, in candidate form (omitted when empty).
function publishedTerms(p) {
  const extra = (p?.category_ids ?? []).filter((id) => id !== p?.category_id);
  return {
    ...(extra.length ? { extraCategoryIds: extra } : {}),
    ...(p?.tag_ids?.length ? { tagIds: p.tag_ids } : {}),
  };
}
function download(name, data) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
// Applies the resource form (URL, titles, descriptions) to the master JSON. Only those
// fields have form inputs; every other field, including the rich translation fields
// (tagline, features, FAQ, content, ...), is kept from the JSON. Clearing both title and
// description drops the language entirely, rich fields included.
export function applyResourceForm(data, form) {
  const next = { ...data, url: form.url, translations: {} };
  for (const lang of ["zh", "en"]) {
    const { title, description } = form[lang];
    const { title: _t, description: _d, ...rest } = data.translations?.[lang] ?? {};
    if (title || description)
      next.translations[lang] = { title, description, ...rest };
  }
  return next;
}
// Merges an AI "enrich" output into one locale of the master data. Title and description
// stay as they are; the rich fields the AI returned replace the existing ones.
export function mergeEnrichment(data, locale, output) {
  const current = data.translations?.[locale];
  if (!current) throw new Error(`主档还没有 ${locale} 的名称和说明`);
  const rich = {};
  for (const key of ["tagline", "features", "useCases", "pros", "cons", "content", "faqs"])
    if (output[key] !== undefined) rich[key] = output[key];
  return {
    ...data,
    translations: { ...data.translations, [locale]: { ...current, ...rich } },
  };
}
export function splitResourceExchange(bundle) {
  if (
    bundle.schemaVersion !== 1 ||
    bundle.kind !== "resources" ||
    !Array.isArray(bundle.resources)
  )
    throw new Error("资源文件格式不正确");
  const make = (resources) => ({
    schemaVersion: 1,
    kind: "resources",
    resources,
  });
  const bytes = (value) => new TextEncoder().encode(value).byteLength;
  const fits = (part) =>
    bytes(JSON.stringify(part, null, 2)) <= 262144 &&
    bytes(JSON.stringify({ bundle: part, apply: false })) <= 262144;
  const parts = [];
  let resources = [];
  for (const resource of bundle.resources) {
    if (!fits(make([resource])))
      throw new Error("单条资源超过文件导入上限，请缩短内容后重试。");
    if (resources.length === 100 || !fits(make([...resources, resource]))) {
      parts.push(make(resources));
      resources = [];
    }
    resources.push(resource);
  }
  if (resources.length || !parts.length) parts.push(make(resources));
  return parts;
}
export async function renderResources(
  root,
  api,
  notice,
  query = "",
  page = 1,
  ready = () => true,
) {
  const load = beginContentLoad(root);
  let resources;
  try {
    resources = await api(
      "/resources?q=" + encodeURIComponent(query) + "&page=" + page,
    );
  } catch (error) {
    if (load.current() && ready()) throw error;
    return;
  } finally {
    load.finish();
  }
  if (!load.current() || !ready()) return;
  let selected = null,
    selectionGeneration = 0,
    bundle = null,
    fileGeneration = 0;
  root.innerHTML = `<span class="eyebrow">THE SHARED LIBRARY</span><h1>共享事实，各站表达。</h1><p class="muted">主档更新保留历史版本。各站选择新版并发布后，线上内容才会更新。</p><div class="split"><section class="panel"><h2>资源主档</h2><label for="resource-search">按标识查找</label><input id="resource-search" value="${escape(query)}"><button class="secondary" id="search-resources">查找</button><button class="secondary" id="refresh-resources">刷新列表（保留编辑）</button><div class="table-wrap"><table id="resource-list"><thead><tr><th>标识</th><th>版本</th><th>操作</th></tr></thead><tbody>${resourceRows(resources)}</tbody></table></div></section><section class="panel"><h2 id="resource-heading">新增资源</h2><label for="resource-id">稳定标识</label><input id="resource-id" placeholder="my-resource"><label for="resource-url">网站地址</label><input id="resource-url" type="url"><label for="resource-zh-title">中文名称</label><input id="resource-zh-title"><label for="resource-zh-description">中文说明</label><textarea id="resource-zh-description"></textarea><label for="resource-en-title">English name（可选）</label><input id="resource-en-title"><label for="resource-en-description">English description（可选）</label><textarea id="resource-en-description"></textarea><label for="resource-data">完整内容 JSON（与表单同步）</label><textarea id="resource-data"></textarea><p class="muted">表单只编辑名称和说明。定价 pricing（free、freemium、paid、trial、open-source、contact）以及各语言的 tagline、features、useCases、pros、cons、content（Markdown）、faqs 在 JSON 中编辑，表单改动会保留这些字段。</p><label><input type="checkbox" id="resource-public" checked>允许公开展示</label><label for="resource-note">内部备注</label><textarea id="resource-note"></textarea><div class="actions"><button id="save-resource">保存新版本</button><button id="new-resource" class="secondary">新增另一条</button></div><pre id="resource-history"></pre></section></div><section class="panel"><h2>文件协作</h2><p class="muted">交换文件不包含内部备注。导入先整体检查，任何版本冲突都会阻止整批写入。</p><button id="export-resources" class="secondary">导出此页资源 JSON</button><label for="resource-file">选择资源文件</label><input id="resource-file" type="file" accept=".json"><div class="actions"><button id="check-import" class="secondary">检查导入</button><button id="apply-import">执行导入</button></div><pre id="import-result"></pre></section>`;
  const editor = editorGuard(root, "#resource-id");
  const resourceList = root.querySelector("#resource-list");
  const alive = () => root.querySelector("#resource-list") === resourceList;
  const buttonBusy = new Set();
  let saveBusy = false,
    importBusy = false,
    refreshBusy = false,
    importCommitted = false,
    listStale = false,
    operationGeneration = 0;
  const blocked = (id) => {
    if (id === "save-resource") return saveBusy || importBusy || refreshBusy;
    if (id === "apply-import")
      return saveBusy || importBusy || refreshBusy || importCommitted;
    if (id === "check-import") return importBusy || importCommitted;
    if (id === "refresh-resources")
      return saveBusy || importBusy || refreshBusy;
    if (["search-resources", "prev-resources", "next-resources"].includes(id))
      return importBusy || refreshBusy;
    return false;
  };
  const update = () => {
    if (!alive()) return;
    for (const button of root.querySelectorAll("button[id]"))
      button.disabled = blocked(button.id) || buttonBusy.has(button.id);
    root.querySelector("#resource-file").disabled = importBusy;
    for (const button of root.querySelectorAll(".edit-resource"))
      button.disabled = importBusy || listStale;
  };
  const bindResource = (id, fn) => {
    root.querySelector("#" + id)?.addEventListener("click", async () => {
      if (!alive() || blocked(id) || buttonBusy.has(id)) return;
      buttonBusy.add(id);
      if (id === "save-resource") {
        saveBusy = true;
        operationGeneration++;
      }
      if (id === "apply-import") {
        importBusy = true;
        operationGeneration++;
      }
      if (id === "refresh-resources") refreshBusy = true;
      const generation = operationGeneration;
      const current = () => alive() && generation === operationGeneration;
      update();
      try {
        await fn(current);
      } catch (error) {
        if (current()) notice(error.message, true);
      } finally {
        buttonBusy.delete(id);
        if (id === "save-resource") saveBusy = false;
        if (id === "apply-import") importBusy = false;
        if (id === "refresh-resources") refreshBusy = false;
        update();
      }
    });
  };

  for (const id of [
    "resource-id",
    "resource-data",
    "resource-url",
    "resource-zh-title",
    "resource-zh-description",
    "resource-en-title",
    "resource-en-description",
    "resource-public",
    "resource-note",
  ])
    root.querySelector("#" + id).addEventListener("input", editor.change);
  root
    .querySelector(".table-wrap")
    .insertAdjacentHTML(
      "afterend",
      '<div class="actions" id="resource-pagination"></div>',
    );
  const updatePagination = () => {
    root.querySelector("#resource-pagination").innerHTML =
      `${page > 1 ? '<button id="prev-resources" class="secondary">上一页</button>' : ""}${resources.length === 100 ? '<button id="next-resources" class="secondary">下一页</button>' : ""}`;
    bindResource("prev-resources", () =>
      renderResources(root, api, notice, query, page - 1),
    );
    bindResource("next-resources", () =>
      renderResources(root, api, notice, query, page + 1),
    );
  };
  updatePagination();
  const refreshRows = async () => {
    const generation = operationGeneration;
    const rows = await api(
      "/resources?q=" + encodeURIComponent(query) + "&page=" + page,
    );
    if (!alive() || generation !== operationGeneration) return false;
    // Replace cache entries; never mutate the selected editor's reviewed baseline.
    resources.splice(0, resources.length, ...rows);
    resourceList.querySelector("tbody").innerHTML = resourceRows(resources);
    listStale = false;
    updatePagination();
    update();
    return true;
  };
  bindResource("refresh-resources", async () => {
    if (await refreshRows())
      notice("资源列表已刷新，现有编辑内容与版本已保留。");
  });
  bindResource("search-resources", async () =>
    renderResources(
      root,
      api,
      notice,
      root.querySelector("#resource-search").value,
      1,
    ),
  );
  const populateFields = (data) => {
    root.querySelector("#resource-url").value = data.url ?? "";
    for (const lang of ["zh", "en"])
      for (const field of ["title", "description"])
        root.querySelector("#resource-" + lang + "-" + field).value =
          data.translations?.[lang]?.[field] ?? "";
  };
  root.querySelector("#resource-data").addEventListener("input", (event) => {
    try {
      populateFields(JSON.parse(event.target.value));
    } catch {
      /* Keep incomplete JSON for correction. */
    }
  });
  for (const field of [
    "url",
    "zh-title",
    "zh-description",
    "en-title",
    "en-description",
  ])
    root.querySelector("#resource-" + field).addEventListener("input", () => {
      try {
        const data = JSON.parse(root.querySelector("#resource-data").value);
        const value = (field) =>
          root.querySelector("#resource-" + field).value;
        const next = applyResourceForm(data, {
          url: value("url"),
          zh: { title: value("zh-title"), description: value("zh-description") },
          en: { title: value("en-title"), description: value("en-description") },
        });
        root.querySelector("#resource-data").value = JSON.stringify(
          next,
          null,
          2,
        );
      } catch {
        notice("请先修复完整 JSON 的格式。", true);
      }
    });
  const populate = (r) => {
    selectionGeneration++;
    editor.change();
    root.querySelector("#resource-history").textContent = "";
    selected = r;
    root.querySelector("#resource-id").value = r?.id ?? "";
    root.querySelector("#resource-id").readOnly = !!r;
    root.querySelector("#resource-data").value = JSON.stringify(
      r?.data ?? {
        url: "",
        source: "manual",
        translations: {
          zh: {
            title: "",
            description: "",
          },
        },
      },
      null,
      2,
    );
    populateFields(JSON.parse(root.querySelector("#resource-data").value));
    root.querySelector("#resource-public").checked = r?.public ?? true;
    root.querySelector("#resource-note").value = r?.internal_note ?? "";
    root.querySelector("#resource-heading").textContent = r
      ? "编辑 · " + r.id
      : "新增资源";
  };
  populate(null);
  resourceList.addEventListener("click", async (event) => {
    const button = event.target.closest(".edit-resource");
    if (
      !button ||
      !resourceList.contains(button) ||
      importBusy ||
      listStale ||
      !alive()
    )
      return;
    populate(resources.find((r) => r.id === button.dataset.id));
    const current = editor.start(true);
    try {
      await guarded(
        current,
        () => api("/resources/" + button.dataset.id),
        (result) => {
          root.querySelector("#resource-history").textContent = JSON.stringify(
            result,
            null,
            2,
          );
        },
      );
    } catch (error) {
      notice(error.message, true);
    }
  });
  bindResource("save-resource", async () => {
    const current = editor.start(),
      selection = selectionGeneration,
      idNode = root.querySelector("#resource-id");
    const value = {
      id: idNode.value,
      expectedVersion: selected?.version ?? 0,
      data: JSON.parse(root.querySelector("#resource-data").value),
      public: root.querySelector("#resource-public").checked,
      internalNote: root.querySelector("#resource-note").value,
    };
    let result;
    try {
      result = await api("/resources", value);
    } catch (error) {
      if (
        root.querySelector("#resource-id") === idNode &&
        selection === selectionGeneration &&
        idNode.value === value.id
      )
        throw error;
      return;
    }
    if (root.querySelector("#resource-id") !== idNode) return;
    // Acknowledge this write independently of later typing or selection changes.
    const record = {
      id: value.id,
      version: result.version,
      data: value.data,
      public: value.public,
      internal_note: value.internalNote,
    };
    const cached = resources.find((r) => r.id === value.id);
    if (cached) Object.assign(cached, record);
    const saved = cached ?? record;
    for (const button of root.querySelectorAll(".edit-resource"))
      if (button.dataset.id === value.id)
        button.closest("tr").children[1].textContent = String(result.version);
    if (selection !== selectionGeneration || idNode.value !== value.id) return;
    selected = saved;
    idNode.readOnly = true;
    root.querySelector("#resource-heading").textContent = "编辑 · " + value.id;
    if (!current()) {
      notice("主档新版本已保存；后续输入尚未保存。");
      return;
    }
    notice("主档新版本已保存；各站线上内容保持其已发布版本。");
    try {
      await renderResources(root, api, notice, query, page, current);
    } catch {
      if (current())
        notice("主档新版本已保存；列表刷新失败，可重新查找。", true);
    }
  });
  bindResource("new-resource", async () => populate(null));
  const exports = document.createElement("div");
  exports.className = "actions";
  exports.id = "resource-exports";
  root.querySelector("#export-resources").after(exports);
  bindResource("export-resources", async (current) => {
    const result = await api(
      "/resources/exchange?q=" + encodeURIComponent(query) + "&page=" + page,
    );
    if (!current()) return;
    const parts = splitResourceExchange(result);
    exports.replaceChildren();
    if (parts.length === 1) return download("resources.json", parts[0]);
    notice(
      `此页已拆成 ${parts.length} 份可导入文件，请分别下载；每份独立检查和导入。`,
    );
    for (const [index, part] of parts.entries()) {
      const button = document.createElement("button");
      button.className = "secondary";
      button.textContent = `下载第 ${index + 1} 份（${part.resources.length} 条）`;
      button.addEventListener("click", () =>
        download(`resources-${index + 1}.json`, part),
      );
      exports.append(button);
    }
  });
  const fileInput = root.querySelector("#resource-file");
  const currentFile = (generation) =>
    generation === fileGeneration &&
    root.querySelector("#resource-file") === fileInput;
  root
    .querySelector("#resource-file")
    .addEventListener("change", async (event) => {
      if (importBusy || !alive()) return;
      importCommitted = false;
      update();
      const generation = ++fileGeneration;
      bundle = null;
      root.querySelector("#import-result").textContent = "";
      try {
        const file = event.target.files[0];
        if (!file) {
          notice("已清除文件选择。");
          return;
        }
        notice("正在读取资源文件…");
        if (file.size > 262144) throw new Error("文件超过 256 KiB");
        const parsed = JSON.parse(await file.text());
        if (!currentFile(generation)) return;
        if (
          new TextEncoder().encode(
            JSON.stringify({ bundle: parsed, apply: false }),
          ).byteLength > 262144
        )
          throw new Error("文件内容加上导入请求超过 256 KiB，请拆分文件。");
        bundle = parsed;
        notice("文件已载入，请检查导入。");
      } catch (error) {
        if (!currentFile(generation)) return;
        bundle = null;
        notice(error.message, true);
      }
    });
  const submitFile = async (apply) => {
    if (!bundle) throw new Error("请先选择文件");
    const generation = fileGeneration;
    try {
      const result = await api("/resources/exchange", { bundle, apply });
      return currentFile(generation) ? result : null;
    } catch (error) {
      if (currentFile(generation)) throw error;
      return null;
    }
  };
  bindResource("check-import", async () => {
    const result = await submitFile(false);
    if (result)
      root.querySelector("#import-result").textContent = JSON.stringify(
        result,
        null,
        2,
      );
  });
  bindResource("apply-import", async () => {
    if (!bundle) throw new Error("请先选择文件");
    const submitted = bundle;
    fileGeneration++;
    editor.change();
    const result = await api("/resources/exchange", {
      bundle: submitted,
      apply: true,
    });
    if (!alive()) return;
    // A write acknowledgement belongs to its submitted bundle, not a later file selection.
    importCommitted = true;
    bundle = null;
    fileInput.value = "";
    listStale = true;
    root.querySelector("#import-result").textContent = JSON.stringify(
      result,
      null,
      2,
    );
    const message =
      "资源已导入。现有主档编辑内容与版本已保留，请比较后再保存。";
    notice(message);
    update();
    try {
      await refreshRows();
    } catch (error) {
      if (alive())
        notice(
          message + " 列表刷新失败：" + error.message + "。请刷新列表确认。",
          true,
        );
    }
  });
  update();
}
export async function renderContent(
  site,
  root,
  api,
  notice,
  selection,
  page = 1,
  ready = () => true,
  bulk = false,
) {
  const base = "/content/" + encodeURIComponent(site);
  const load = beginContentLoad(root);
  let loaded;
  try {
    loaded = await Promise.all([
      api(base + "/publications?page=" + page),
      api(base + "/categories"),
      api(base + "/submissions?page=" + page),
      api(base + "/tags"),
      api(base + "/collections"),
    ]);
  } catch (error) {
    if (load.current() && ready()) throw error;
    return;
  } finally {
    load.finish();
  }
  if (!load.current() || !ready()) return;
  const [publications, categories, submissions, tags, collections] = loaded;
  let selected = null,
    selectionGeneration = 0,
    writeBusy = false,
    baselineText = "",
    operation = crypto.randomUUID();
  root.innerHTML = `<a href="#site/${escape(site)}">← 站点配置</a><span class="eyebrow"> / CONTENT DESK</span><h1>本站内容 · ${escape(site)}</h1><section class="panel"><h2>发布记录</h2>${bulk ? `<div class="actions"><button class="secondary" id="bulk-select-drafts">选择有草稿</button><button id="bulk-publish">批量发布选中</button><span class="muted" id="bulk-status">选择有草稿的记录</span></div>` : ""}<div class="table-wrap"><table id="publication-list"><thead><tr>${bulk ? "<th>选择</th>" : ""}<th>资源 / 语言</th><th>线上状态</th><th>主档</th><th>操作</th></tr></thead><tbody>${publicationRows(publications, bulk)}</tbody></table></div></section><section class="panel"><h2>内容草稿</h2><div class="split"><div><label for="publication-resource">资源标识</label><input id="publication-resource"><label for="publication-locale">语言</label><select id="publication-locale"><option value="zh">中文</option><option value="en">English</option></select></div><div><label for="publication-candidate">完整候选 JSON</label><textarea id="publication-candidate"></textarea></div></div><div class="actions"><button id="stage-content">保存草稿</button><button id="publish-content">发布草稿</button><button id="preview-content" class="secondary">预览</button><button id="diff-content" class="secondary">载入并比较主档新版</button><button id="diagnose-content" class="secondary">检查可见性</button><button id="unpublish-content" class="secondary">下架</button><button id="new-content" class="secondary">分发新资源</button></div><p class="muted">overrides 只覆盖本站文案（可含 tagline、content，以及媒体库图片 image、logo）；categoryId 是主分类，extraCategoryIds、tagIds 填本站其他分类和标签的标识。比较新版优先保留已保存草稿，没有草稿时采用线上记录。请先保存本页编辑再比较。保存草稿不更改线上内容。</p><pre id="content-result"></pre></section><section class="panel"><h2>AI 辅助</h2><p class="muted">只生成候选文案，不会自动保存或发布。需要先在站点页“AI 设置”启用并配置供应商。富字段补全的结果写入资源主档的新版本（仅站群管理员），之后用“载入并比较主档新版”采用。</p><div class="split"><div><label for="ai-kind">操作</label><select id="ai-kind"><option value="generate">生成/改写标题与说明</option><option value="translate">翻译标题与说明</option><option value="seo">生成 SEO 标题与说明</option><option value="enrich">补全富字段（tagline、功能、FAQ 等）</option></select><label for="ai-brief">额外要求（可选）</label><input id="ai-brief" maxlength="500" placeholder="例如：更简洁，面向开发者"></div></div><div class="actions"><button id="ai-run">生成建议</button><button id="ai-apply" class="secondary" disabled>应用到候选 JSON</button></div><pre id="ai-result"></pre></section>${taxonomyPanel("category", "分类", categories)}${taxonomyPanel("tag", "标签", tags)}<section class="panel"><h2>本站榜单</h2><p class="muted">榜单按顺序列出资源，例如热门、编辑精选。每种语言只显示该语言已发布的资源；保存即生效。</p><div class="actions" id="collection-choices">${categoryButtons(collections, "collection")}</div><div class="split"><div><label for="collection-id">标识</label><input id="collection-id"><label for="collection-labels">名称 JSON</label><input id="collection-labels" value='{"zh":"新榜单"}'><label for="collection-descriptions">说明 JSON（可选）</label><input id="collection-descriptions" value="{}"><label for="collection-rank">排序（较小的在前）</label><input id="collection-rank" type="number" value="0"><label><input type="checkbox" id="collection-active" checked>启用榜单</label></div><div><label for="collection-items">资源标识（每行一个，按顺序）</label><textarea id="collection-items"></textarea></div></div><div class="actions"><button id="save-collection">保存榜单</button><button id="new-collection" class="secondary">新增榜单</button></div></section><section class="panel"><h2>投稿审核</h2>${submissions.map((s, i) => `<article class="resource"><strong>${escape(s.data.title)}</strong><p>${escape(s.data.url)}</p><p>${escape(s.data.description)}</p><p class="muted review-status">${escape(s.status)} · ${escape(s.note)}</p>${s.resource_id ? `<p class="project-facts review-resource">生成草稿资源：${escape(s.resource_id)}</p>` : ""}${s.status === "pending" ? `<label for="review-note-${i}">审核说明</label><input id="review-note-${i}" maxlength="500"><div class="actions"><button class="review" data-index="${i}" data-decision="accepted">接受为资源草稿</button><button class="review secondary" data-index="${i}" data-decision="rejected">拒绝</button></div>` : ""}</article>`).join("") || '<p class="muted">暂无投稿。</p>'}</section>`;
  root
    .querySelector(".table-wrap")
    .insertAdjacentHTML(
      "afterend",
      `<div class="actions" id="content-pagination"></div>`,
    );
  const editor = editorGuard(root, "#publication-candidate");
  const publicationList = root.querySelector("#publication-list");
  const alive = () =>
    root.querySelector("#publication-list") === publicationList;
  let refreshGeneration = 0,
    refreshBulk = () => {};
  const refreshButton = document.createElement("button");
  refreshButton.className = "secondary";
  refreshButton.id = "refresh-publications";
  refreshButton.textContent = "刷新发布记录";
  publicationList.closest(".table-wrap").after(refreshButton);
  for (const id of [
    "publication-resource",
    "publication-locale",
    "publication-candidate",
  ])
    root.querySelector("#" + id).addEventListener("input", () => {
      editor.change();
      root.querySelector("#content-result").textContent = "";
    });
  const updatePagination = () => {
    root.querySelector("#content-pagination").innerHTML =
      `${page > 1 ? '<button id="prev-content" class="secondary">上一页</button>' : ""}${publications.length === 100 || submissions.length === 100 ? '<button id="next-content" class="secondary">下一页</button>' : ""}`;
    bind(root, "prev-content", notice, () =>
      renderContent(site, root, api, notice, undefined, page - 1, undefined, bulk),
    );
    bind(root, "next-content", notice, () =>
      renderContent(site, root, api, notice, undefined, page + 1, undefined, bulk),
    );
  };
  updatePagination();
  const candidateText = (p) =>
    JSON.stringify(
      p?.candidate ?? {
        resourceVersion: p?.resource_version ?? 1,
        slug: p?.slug ?? p?.id ?? "new-resource",
        categoryId: p?.category_id ?? null,
        ...publishedTerms(p),
        rank: p?.rank ?? 0,
        overrides: p?.overrides ?? {},
      },
      null,
      2,
    );
  const populate = (p) => {
    selectionGeneration++;
    editor.change();
    root.querySelector("#content-result").textContent = "";
    selected = p ? { ...p } : null;
    operation = crypto.randomUUID();
    root.querySelector("#publication-resource").value = p?.id ?? "";
    root.querySelector("#publication-locale").value = p?.locale ?? "zh";
    root.querySelector("#publication-resource").readOnly = !!p;
    root.querySelector("#publication-locale").disabled = !!p;
    baselineText = candidateText(p);
    root.querySelector("#publication-candidate").value = baselineText;
  };
  populate(
    selection
      ? (publications.find(
          (p) => p.id === selection.id && p.locale === selection.locale,
        ) ?? null)
      : null,
  );
  const identity = () => ({
    id: root.querySelector("#publication-resource").value,
    locale: root.querySelector("#publication-locale").value,
  });
  const path = () => {
    const { id, locale } = identity();
    return base + "/" + encodeURIComponent(id) + "/" + locale;
  };
  const expected = () => ({
    published: selected?.version ?? 0,
    draft: selected?.draft_version ?? 0,
  });
  const refreshPublications = async () => {
    const generation = ++refreshGeneration;
    let rows;
    try {
      rows = await api(base + "/publications?page=" + page);
    } catch (error) {
      if (alive() && generation === refreshGeneration) throw error;
      return null;
    }
    if (!alive() || generation !== refreshGeneration) return null;
    publications.splice(0, publications.length, ...rows);
    publicationList.querySelector("tbody").innerHTML =
      publicationRows(publications, bulk);
    refreshBulk();
    updatePagination();
    return true;
  };
  bind(root, "refresh-publications", notice, async () => {
    const refreshed = await refreshPublications();
    if (refreshed !== null && alive())
      notice("发布记录已刷新，其他编辑内容已保留。");
  });
  if (bulk) {
    const status = root.querySelector("#bulk-status"),
      publishButton = root.querySelector("#bulk-publish"),
      selectButton = root.querySelector("#bulk-select-drafts");
    let bulkBusy = false;
    const boxes = () => [
      ...publicationList.querySelectorAll(".bulk-publication"),
    ];
    const selected = () =>
      boxes()
        .filter((box) => box.checked)
        .map((box) => publications[Number(box.dataset.index)])
        .filter((p) => p && p.draft_version > 0);
    const update = () => {
      if (!alive()) return;
      const items = selected();
      status.textContent = items.length
        ? `已选 ${items.length} 项`
        : "选择有草稿的记录";
      publishButton.disabled = bulkBusy || !items.length || items.length > 20;
      selectButton.disabled = bulkBusy;
      for (const box of boxes())
        box.disabled =
          bulkBusy ||
          !publications[Number(box.dataset.index)]?.draft_version;
    };
    publicationList.addEventListener("change", (event) => {
      if (
        event.target instanceof HTMLInputElement &&
        event.target.classList.contains("bulk-publication")
      )
        update();
    });
    selectButton.addEventListener("click", () => {
      for (const box of boxes()) box.checked = !box.disabled;
      update();
    });
    publishButton.addEventListener("click", async () => {
      if (bulkBusy) return;
      const items = selected();
      if (!items.length) return;
      if (items.length > 20) {
        notice("一次最多发布 20 项。", true);
        return;
      }
      bulkBusy = true;
      update();
      try {
        const data = await api("/content/batch-publish", {
          items: items.map((p) => ({
            siteId: site,
            resourceId: p.id,
            locale: p.locale,
            expected: { published: p.version ?? 0, draft: p.draft_version },
            operationId: crypto.randomUUID(),
          })),
        });
        const failed = data.results.filter((result) => !result.ok);
        root.querySelector("#content-result").textContent = JSON.stringify(
          data.results,
          null,
          2,
        );
        notice(
          `批量发布完成：${data.results.length - failed.length} 成功，${failed.length} 失败。` +
            (failed.length ? "失败项保留原草稿。" : ""),
        );
        await refreshPublications();
        update();
      } catch (error) {
        notice("批量发布失败：" + error.message, true);
      } finally {
        bulkBusy = false;
        update();
      }
    });
    refreshBulk = update;
    update();
  }
  const write = async (action, payload, message) => {
    if (writeBusy) return;
    writeBusy = true;
    const buttons = [
      "stage-content",
      "publish-content",
      "unpublish-content",
    ].map((id) => root.querySelector("#" + id));
    for (const button of buttons) button.disabled = true;
    const current = editor.start(),
      target = identity(),
      selection = selectionGeneration,
      baseline = selected ? { ...selected } : { ...target },
      hadEdits =
        root.querySelector("#publication-candidate").value !== baselineText;
    const sameTarget = () =>
      alive() &&
      selection === selectionGeneration &&
      identity().id === target.id &&
      identity().locale === target.locale;
    try {
      let result;
      try {
        result = await api(path() + "/" + action, payload);
      } catch (error) {
        if (sameTarget()) throw error;
        return;
      }
      if (!alive()) return;
      const record = { ...baseline, ...target };
      if (action === "stage") {
        record.version = payload.expected.published;
        record.draft_version = result.draftVersion;
        record.candidate = payload.candidate;
        record.resource_version ??= payload.candidate.resourceVersion;
      } else if (action === "publish") {
        const draft = baseline.candidate;
        Object.assign(record, {
          version: result.version,
          draft_version: payload.expected.draft + 1,
          status: "published",
          candidate: null,
          slug: draft?.slug ?? baseline.slug,
          category_id: draft?.categoryId ?? null,
          category_ids: [
            ...new Set(
              [draft?.categoryId, ...(draft?.extraCategoryIds ?? [])].filter(Boolean),
            ),
          ],
          tag_ids: [...new Set(draft?.tagIds ?? [])],
          rank: draft?.rank ?? 0,
          overrides: draft?.overrides ?? {},
          source_version: draft?.resourceVersion ?? baseline.source_version,
        });
      } else {
        record.version = result.version;
        record.status = "draft";
      }
      // Only this write's acknowledgement advances the editor baseline.
      ++refreshGeneration;
      const index = publications.findIndex(
        (p) => p.id === target.id && p.locale === target.locale,
      );
      if (
        index >= 0 &&
        (publications[index].version ?? 0) <= (record.version ?? 0) &&
        (publications[index].draft_version ?? 0) <= (record.draft_version ?? 0)
      ) {
        publications[index] = record;
        publicationList.querySelector("tbody").innerHTML =
          publicationRows(publications, bulk);
        refreshBulk();
      }
      if (!sameTarget()) return;
      const unchanged = current() && (action === "stage" || !hadEdits);
      selected = record;
      baselineText = candidateText(record);
      operation = crypto.randomUUID();
      root.querySelector("#publication-resource").readOnly = true;
      root.querySelector("#publication-locale").disabled = true;
      if (unchanged) populate(record);
      const confirmedSelection = selectionGeneration,
        confirmed = editor.start();
      const stillSelected = () =>
        alive() &&
        selectionGeneration === confirmedSelection &&
        identity().id === target.id &&
        identity().locale === target.locale;
      const savedMessage = () =>
        message + (!unchanged || !confirmed() ? " 后续输入尚未保存。" : "");
      notice(savedMessage());
      try {
        const refreshed = await refreshPublications();
        if (refreshed !== null && stillSelected()) notice(savedMessage());
      } catch {
        if (stillSelected())
          notice(
            savedMessage() + " 发布记录刷新失败，请点击“刷新发布记录”重试。",
            true,
          );
      }
    } finally {
      writeBusy = false;
      for (const button of buttons)
        if (button.isConnected) button.disabled = false;
    }
  };
  const inspect = async (action, adopt = false) => {
    const current = editor.start(true);
    await guarded(
      current,
      () => api(path() + "/" + action),
      (result) => {
        if (adopt) {
          editor.change();
          root.querySelector("#publication-candidate").value = JSON.stringify(
            result.candidate,
            null,
            2,
          );
          notice("已载入候选和差异，检查后保存；尚未发布。");
        }
        root.querySelector("#content-result").textContent = JSON.stringify(
          result,
          null,
          2,
        );
      },
    );
  };
  publicationList.addEventListener("click", (event) => {
    const button = event.target.closest(".edit-publication");
    if (button && publicationList.contains(button))
      populate(publications[Number(button.dataset.index)]);
  });
  bind(root, "new-content", notice, async () => populate(null));
  bind(root, "stage-content", notice, async () => {
    await write(
      "stage",
      {
        candidate: JSON.parse(
          root.querySelector("#publication-candidate").value,
        ),
        expected: expected(),
      },
      "内容草稿已保存。",
    );
  });
  bind(root, "publish-content", notice, async () => {
    await write(
      "publish",
      {
        expected: expected(),
        operationId: operation,
      },
      "本站内容已发布。",
    );
  });
  bind(root, "diff-content", notice, () => inspect("diff", true));
  bind(root, "preview-content", notice, () => inspect("preview"));
  bind(root, "diagnose-content", notice, () => inspect("diagnose"));
  bind(root, "unpublish-content", notice, async () => {
    await write(
      "unpublish",
      { expectedVersion: expected().published },
      "本站内容已下架。",
    );
  });
  let aiOutput = null,
    aiKind = null,
    aiTarget = null,
    aiBusy = false;
  const aiResult = root.querySelector("#ai-result"),
    aiApply = root.querySelector("#ai-apply");
  aiApply.addEventListener("click", async () => {
    if (!aiOutput) return;
    if (aiKind === "enrich") {
      // Rich fields live on the shared master: write a new master version (network
      // admins only); sites then adopt it through the usual comparison and publish.
      if (aiBusy) return;
      aiBusy = true;
      aiApply.disabled = true;
      try {
        const { id, locale } = aiTarget;
        const rows = await api("/resources?q=" + encodeURIComponent(id));
        const master = rows.find((row) => row.id === id);
        if (!master) throw new Error("找不到资源主档 " + id);
        await api("/resources", {
          id,
          expectedVersion: master.version,
          data: mergeEnrichment(master.data, locale, aiOutput),
          public: master.public,
          internalNote: master.internal_note,
        });
        aiResult.textContent = `已写入主档 ${id} 的新版本（${locale}）。请用“载入并比较主档新版”检查后保存草稿并发布。`;
        notice("富字段已写入主档新版本。");
      } catch (error) {
        aiApply.disabled = false;
        notice("写入主档失败：" + error.message, true);
      } finally {
        aiBusy = false;
      }
      return;
    }
    try {
      const candidate = JSON.parse(
        root.querySelector("#publication-candidate").value,
      );
      candidate.overrides = candidate.overrides ?? {};
      for (const key of ["title", "description", "seoTitle", "seoDescription"])
        if (aiOutput[key]) candidate.overrides[key] = aiOutput[key];
      root.querySelector("#publication-candidate").value = JSON.stringify(
        candidate,
        null,
        2,
      );
      editor.change();
      aiResult.textContent = "已写入候选 JSON，仍需保存草稿并人工发布。";
    } catch (error) {
      notice("候选 JSON 无法解析：" + error.message, true);
    }
  });
  bind(root, "ai-run", notice, async () => {
    if (aiBusy) return;
    const kind = root.querySelector("#ai-kind").value,
      locale = root.querySelector("#publication-locale").value;
    if (kind === "enrich" && !bulk)
      throw new Error("富字段补全会写入资源主档，需要站群管理员操作");
    if (kind === "enrich" && !selected)
      throw new Error("请先在发布记录中选择一个资源");
    const candidate = JSON.parse(
      root.querySelector("#publication-candidate").value,
    );
    // Enrichment starts from the master's own text for this locale.
    const master = kind === "enrich" ? selected.data?.translations?.[locale] : null;
    const title =
      master?.title ??
      candidate.overrides?.title ??
      selected?.title ??
      "";
    const description =
      master?.description ??
      candidate.overrides?.description ??
      selected?.description ??
      "";
    if (!title && !description)
      throw new Error("当前候选没有标题或说明可供 AI 参考");
    aiBusy = true;
    aiApply.disabled = true;
    aiOutput = null;
    aiKind = kind;
    aiTarget = { id: selected?.id, locale };
    aiApply.textContent = kind === "enrich" ? "写入主档新版本" : "应用到候选 JSON";
    aiResult.textContent = "已提交，等待 Worker…";
    try {
      const created = await api("/ai/jobs", {
        site,
        kind,
        locale,
        title: title || undefined,
        description: description || undefined,
        ...(kind === "enrich" && selected?.data?.url ? { url: selected.data.url } : {}),
        brief: root.querySelector("#ai-brief").value.trim(),
      });
      for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        const job = await api(
          "/ai/jobs/" + encodeURIComponent(created.id) + "?site=" + encodeURIComponent(site),
        );
        if (job.status === "failed") throw new Error(job.error || "AI 生成失败");
        if (job.status === "done") {
          aiOutput = job.output;
          aiResult.textContent = JSON.stringify(job.output, null, 2);
          aiApply.disabled = false;
          notice("AI 建议已生成，请人工检查后应用。");
          return;
        }
        aiResult.textContent = "处理中…";
      }
      throw new Error("AI 任务超时，请稍后在任务记录中检查");
    } finally {
      aiBusy = false;
    }
  });
  // Categories and tags share one editor shape; each keeps its own selection.
  for (const [kind, label, rows] of [
    ["category", "分类", categories],
    ["tag", "标签", tags],
  ]) {
    let current = null,
      selection = 0;
    const idNode = root.querySelector(`#${kind}-id`);
    const choices = root.querySelector(`#${kind}-choices`);
    const populateTerm = (c) => {
      selection++;
      current = c;
      idNode.value = c?.id ?? "";
      idNode.readOnly = !!c;
      root.querySelector(`#${kind}-labels`).value = JSON.stringify(
        c?.labels ?? { zh: "新" + label },
      );
      root.querySelector(`#${kind}-rank`).value = c?.rank ?? 0;
      root.querySelector(`#${kind}-active`).checked = c?.active ?? true;
    };
    choices.addEventListener("click", (event) => {
      const button = event.target.closest(".edit-" + kind);
      if (button && choices.contains(button))
        populateTerm(rows.find((c) => c.id === button.dataset.id));
    });
    bind(root, "new-" + kind, notice, async () => populateTerm(null));
    bind(root, "save-" + kind, notice, async () => {
      const started = selection;
      const value = {
        id: idNode.value,
        labels: JSON.parse(root.querySelector(`#${kind}-labels`).value),
        rank: Number(root.querySelector(`#${kind}-rank`).value),
        active: root.querySelector(`#${kind}-active`).checked,
        expectedVersion: current?.version ?? 0,
      };
      let result;
      try {
        result = await api(base + (kind === "tag" ? "/tags" : "/categories"), value);
      } catch (error) {
        if (alive() && started === selection && idNode.value === value.id)
          throw error;
        return;
      }
      if (!alive()) return;
      let saved = rows.find((c) => c.id === value.id);
      const record = {
        id: value.id,
        labels: value.labels,
        rank: value.rank,
        active: value.active,
        version: result.version,
      };
      if (saved) Object.assign(saved, record);
      else {
        saved = record;
        rows.push(saved);
      }
      rows.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
      choices.innerHTML = categoryButtons(rows, kind);
      if (started === selection && idNode.value === value.id) {
        current = saved;
        idNode.readOnly = true;
        notice(label + "已保存。");
      }
    });
  }
  // Collections: the same selection rules as categories, plus the ordered item list.
  {
    let current = null,
      selection = 0;
    const field = (name) => root.querySelector("#collection-" + name);
    const choices = field("choices");
    const populateCollection = (c) => {
      selection++;
      current = c;
      field("id").value = c?.id ?? "";
      field("id").readOnly = !!c;
      field("labels").value = JSON.stringify(c?.labels ?? { zh: "新榜单" });
      field("descriptions").value = JSON.stringify(c?.descriptions ?? {});
      field("rank").value = c?.rank ?? 0;
      field("active").checked = c?.active ?? true;
      field("items").value = (c?.items ?? []).join("\n");
    };
    choices.addEventListener("click", (event) => {
      const button = event.target.closest(".edit-collection");
      if (button && choices.contains(button))
        populateCollection(collections.find((c) => c.id === button.dataset.id));
    });
    bind(root, "new-collection", notice, async () => populateCollection(null));
    bind(root, "save-collection", notice, async () => {
      const started = selection;
      const value = {
        id: field("id").value,
        labels: JSON.parse(field("labels").value),
        descriptions: JSON.parse(field("descriptions").value || "{}"),
        rank: Number(field("rank").value),
        active: field("active").checked,
        items: field("items")
          .value.split(/\s+/)
          .map((id) => id.trim())
          .filter(Boolean),
        expectedVersion: current?.version ?? 0,
      };
      let result;
      try {
        result = await api(base + "/collections", value);
      } catch (error) {
        if (alive() && started === selection && field("id").value === value.id) throw error;
        return;
      }
      if (!alive()) return;
      let saved = collections.find((c) => c.id === value.id);
      const record = { ...value, version: result.version };
      delete record.expectedVersion;
      if (saved) Object.assign(saved, record);
      else {
        saved = record;
        collections.push(saved);
      }
      collections.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
      choices.innerHTML = categoryButtons(collections, "collection");
      if (started === selection && field("id").value === value.id) {
        current = saved;
        field("id").readOnly = true;
        notice("榜单已保存。");
      }
    });
  }
  for (const b of root.querySelectorAll(".review"))
    b.addEventListener("click", async () => {
      const article = b.closest("article");
      const buttons = [...article.querySelectorAll(".review")];
      const noteInput = article.querySelector("input");
      if (article.getAttribute("aria-busy") === "true") return;
      article.setAttribute("aria-busy", "true");
      for (const button of buttons) button.disabled = true;
      noteInput.disabled = true;
      try {
        const index = Number(b.dataset.index),
          s = submissions[index];
        const value = {
          decision: b.dataset.decision,
          expectedVersion: s.version,
          note: root.querySelector("#review-note-" + index).value,
        };
        const result = await api(base + "/submissions/" + s.id, value);
        if (!alive() || !root.contains(article)) return;
        s.status = value.decision;
        s.note = value.note;
        s.version++;
        s.resource_id = result.resourceId;
        article.querySelector(".review-status").textContent =
          s.status + " · " + s.note;
        for (const button of buttons) button.remove();
        article.querySelector("label")?.remove();
        article.querySelector("input")?.remove();
        if (result.resourceId) {
          const identifier = document.createElement("p");
          identifier.className = "project-facts review-resource";
          identifier.textContent = "生成草稿资源：" + result.resourceId;
          article.append(identifier);
        }
        notice("审核已保存；接受的投稿需要另行发布。");
        if (result.resourceId) {
          try {
            await refreshPublications();
          } catch {
            if (alive())
              notice(
                "审核已保存，但发布记录刷新失败；请点击“刷新发布记录”重试。",
                true,
              );
          }
        }
      } catch (error) {
        notice(error.message, true);
      } finally {
        article.removeAttribute("aria-busy");
        if (noteInput.isConnected) noteInput.disabled = false;
        for (const button of buttons)
          if (button.isConnected) button.disabled = false;
      }
    });
}
