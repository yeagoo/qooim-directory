import { renderGithub, cancelGithubRender } from "./github-admin.js";
import {
  renderResources,
  renderContent,
  cancelContentRender,
} from "./content-admin.js";
const workspace = document.querySelector("#workspace"),
  message = document.querySelector("#message");
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let me,
  sites = [];
let renderGeneration = 0;
const staleView = new Error("View is no longer active");
function notice(text, error = false) {
  message.textContent = text;
  message.className = "notice" + (error ? " error" : "");
}
async function api(path, body) {
  const response = await fetch("/admin/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && workspace) location.assign("/admin/login");
    throw new Error(data.error || "操作失败");
  }
  return data;
}
function bind(id, fn, report = notice) {
  document.getElementById(id)?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await fn();
    } catch (error) {
      report(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}
const login = document.querySelector("#operator-login");
if (login)
  login.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/login", {
        email: login.email.value,
        password: login.password.value,
      });
      location.assign("/admin");
    } catch (error) {
      notice(error.message, true);
    }
  });
if (workspace) {
  bind("logout", async () => {
    await api("/logout", {});
    location.assign("/admin/login");
  });
  void load();
  window.addEventListener("hashchange", () => void render());
}
async function load() {
  try {
    const user = await api("/me");
    const listing = await api("/sites");
    // Do not allow hash navigation to render forms from partial bootstrap data.
    me = user;
    sites = listing;
    document.querySelector("#account").textContent = me.email;
    await render();
  } catch (error) {
    notice(error.message, true);
  }
}
async function render() {
  if (!me) return;
  cancelContentRender(workspace);
  cancelGithubRender(workspace);
  const generation = ++renderGeneration;
  const hash = location.hash;
  notice("");
  const current = () =>
    generation === renderGeneration && location.hash === hash;
  const report = (text, error = false) => {
    if (current()) notice(text, error);
  };
  const scopedApi = async (path, body) => {
    if (!current()) throw staleView;
    try {
      const result = await api(path, body);
      if (!current()) throw staleView;
      return result;
    } catch (error) {
      if (!current()) throw staleView;
      throw error;
    }
  };
  const scope = {
    current,
    api: scopedApi,
    notice: report,
    bind: (id, fn) =>
      bind(
        id,
        () => {
          if (!current()) throw staleView;
          return fn();
        },
        report,
      ),
  };
  workspace.inert = true;
  workspace.setAttribute("aria-busy", "true");
  try {
    await renderView(scope);
  } catch (error) {
    if (error !== staleView && current()) {
      report(error.message, true);
      workspace.innerHTML =
        '<h1>页面暂时无法载入</h1><p class="muted">请重试，或通过导航切换其他页面。</p><button id="retry-page">重新载入</button>';
      scope.bind("retry-page", () => render());
    }
  } finally {
    if (current()) {
      workspace.inert = false;
      workspace.removeAttribute("aria-busy");
    }
  }
}
async function renderView(scope) {
  const { api, notice } = scope;
  const route = location.hash.slice(1);
  if (route === "github") return renderGithub(workspace, api, notice, sites);
  if (route === "resources") return renderResources(workspace, api, notice);
  if (route.startsWith("content/"))
    return renderContent(
      decodeURIComponent(route.slice(8)),
      workspace,
      api,
      notice,
      undefined,
      1,
      undefined,
      Boolean(me.global_admin),
    );
  if (route.startsWith("site/"))
    return edit(decodeURIComponent(route.slice(5)), scope);
  if (route === "team") return team(scope);
  if (route === "tasks") return tasks(scope);
  if (route === "audit") return audit(scope);
  return overview(scope);
}
async function overview(scope, draft) {
  const { api, notice } = scope;
  workspace.innerHTML = `<span class="eyebrow">YOUR NETWORK / ${sites.length} SITES</span><h1>每个站点，都有自己的方向。</h1><p class="muted">在同一个工作台里，保持各站的品牌、配置与发布节奏。</p><button class="secondary" id="refresh-sites">刷新列表</button><div class="grid">${sites.map((site) => `<a class="site-card" href="#site/${encodeURIComponent(site.id)}"><span class="badge">${site.active ? "运行中" : "已停用"} · ${escape(site.state)}</span><h2>${escape(site.config.name)}</h2><p class="muted">${escape(site.host)}</p><small>修订 ${site.revision} · ${site.center_site ? "共享账号（legacy）" : "独立账号"}</small></a>`).join("")}</div>${
    me.global_admin
      ? `<section class="panel"><h2>创建新站点</h2><p class="muted">新站点使用独立账号空间；共享账号中心只保留给既有部署兼容，不再新增。</p><div class="split"><div><label for="site-id">站点标识</label><input id="site-id" placeholder="design-notes"><label for="site-name">站点名称</label><input id="site-name" placeholder="设计札记"></div><div><label for="site-origin">站点地址</label><input id="site-origin" placeholder="https://design.example.com"></div></div><div class="actions"><button id="create">创建站点</button></div></section>`
      : ""
  }`;
  const refresh = workspace.querySelector("#refresh-sites");
  const create = workspace.querySelector("#create");
  const fields = Object.fromEntries(
    (create ? ["site-id", "site-name", "site-origin"] : []).map(
      (id) => [id, workspace.querySelector("#" + id)],
    ),
  );
  if (draft)
    for (const [id, field] of Object.entries(fields)) field.value = draft[id];
  const capture = () =>
    Object.fromEntries(
      Object.entries(fields).map(([id, field]) => [id, field.value]),
    );
  let pending = false,
    committed = false;
  const success = "站点已创建，账号服务正在准备。";
  const active = () => scope.current() && refresh.isConnected;
  const update = () => {
    if (!active()) return;
    for (const field of Object.values(fields))
      field.disabled = pending || committed;
    if (create) create.disabled = pending || committed;
    refresh.disabled = pending;
  };
  const reload = async () => {
    const listing = await api("/sites");
    sites = listing;
    await overview(scope, capture());
  };
  const refreshError = (error) =>
    notice(
      (committed ? success + "但列表刷新失败：" : "列表刷新失败：") +
        error.message +
        "。请刷新列表确认状态。",
      true,
    );
  refresh.addEventListener("click", async () => {
    if (pending || !active()) return;
    pending = true;
    update();
    notice("");
    try {
      await reload();
    } catch (error) {
      refreshError(error);
    } finally {
      pending = false;
      update();
    }
  });
  if (create) {
    create.addEventListener("click", async () => {
      if (pending || committed || !active()) return;
      const value = capture();
      pending = true;
      update();
      notice("");
      try {
        await api("/sites", {
          id: value["site-id"],
          name: value["site-name"],
          origin: value["site-origin"],
          centerSite: null,
        });
      } catch (error) {
        notice(error.message, true);
        pending = false;
        update();
        return;
      }
      committed = true;
      for (const field of Object.values(fields)) field.value = "";
      notice(success);
      try {
        await reload();
      } catch (error) {
        refreshError(error);
      } finally {
        pending = false;
        update();
      }
    });
  }
  update();
}
function providerPanel(data, id) {
  if (data.site.center_site)
    return `<section class="panel"><h2>登录提供方</h2><p class="muted">本站使用账号中心 <a href="#site/${encodeURIComponent(data.site.center_site)}">${escape(data.site.center_site)}</a> 的登录方式；提供方在账号中心配置。</p></section>`;
  const providers = data.authProviders?.providers ?? [];
  return `<section class="panel"><h2>登录提供方</h2>${
    providers.length
      ? `<p class="muted">回调地址必须与提供方控制台完全一致。</p><div class="table-wrap"><table><thead><tr><th>提供方</th><th>状态</th><th>回调地址</th></tr></thead><tbody>${providers.map((p) => `<tr><td>${escape(p.label)} <small>${escape(p.id)}</small></td><td>${p.enabled ? "已启用" : "已停用"}</td><td><code>${escape(p.callbackUrl)}</code></td></tr>`).join("")}</tbody></table></div>`
      : `<p class="muted">尚未配置登录提供方。先运行 <code>pnpm cli auth-provider-check ${escape(id)} .local/github.json</code> 校验，再用 <code>auth-provider-set</code> 写入。</p>`
  }</section>`;
}
async function edit(id, scope, local) {
  const { api, notice } = scope;
  const data = await api("/sites/" + encodeURIComponent(id));
  const config = data.state.draft ?? data.state.config;
  const templates = await api("/templates");
  workspace.innerHTML = `<a href="#">← 站点总览</a> · <a href="#content/${encodeURIComponent(id)}">管理本站内容 →</a><h1>${escape(data.site.config.name)}</h1><p class="muted">${escape(data.site.origin)} · 线上修订 ${data.state.revision} · 草稿版本 ${data.state.draft_version}</p><div class="actions"><a class="button" href="${escape(data.site.origin)}" target="_blank" rel="noopener">访问站点 ↗</a><button class="secondary" id="toggle">${data.site.active ? "停用站点" : "启用站点"}</button></div><section class="panel"><h2>站点配置</h2><div class="actions"><button class="secondary" id="refresh-config">刷新并保留编辑</button><button class="secondary" id="load-server-config">放弃本页编辑并载入服务器配置</button></div><p id="config-local-state" class="muted"></p><div class="split"><div><label for="name">名称</label><input id="name" value="${escape(config.name)}"><label for="tagline">介绍</label><input id="tagline" value="${escape(config.tagline)}"></div><div><label for="template">页面模板</label><select id="template">${templates.map((t) => `<option value="${escape(t.id)}">${escape(t.name)}</option>`).join("")}</select><label for="locales">语言</label><select id="locales"><option value="zh">中文</option><option value="en">English</option><option value="zh,en">中文 + English</option></select><label><input id="opensource" type="checkbox" ${config.modules?.includes("opensource") ? "checked" : ""}>启用开源项目模块</label><label for="module">导航模块</label><select id="module"><option value="on">启用</option><option value="off">停用并保留内容</option></select></div></div><details><summary>完整配置文件与导入</summary><label for="config">配置 JSON</label><textarea id="config" spellcheck="false">${escape(JSON.stringify(config, null, 2))}</textarea><label for="import">选择导入文件</label><input id="import" type="file" accept="application/json,.json"><button class="secondary" id="compare">校验并查看差异</button><pre id="diff"></pre></details><label><input type="checkbox" id="replace"> 我已查看差异，允许替换现有共享草稿</label><div class="actions"><button id="save">保存草稿</button><button id="publish">发布当前草稿</button><button class="secondary" id="preview">预览草稿</button><button class="secondary" id="export">导出线上配置</button></div><p class="muted">保存只更新草稿。发布后，各站进程在配置检查窗口内应用新修订；权限和停站状态立即检查。</p></section>${providerPanel(data, id)}<section class="panel"><h2>发布历史</h2><div class="table-wrap"><table><thead><tr><th>修订</th><th>名称</th><th>操作</th></tr></thead><tbody>${data.history.map((h) => `<tr><td>${h.revision}</td><td>${escape(h.config.name)}</td><td><button class="secondary rollback" data-revision="${h.revision}">恢复为草稿</button></td></tr>`).join("")}</tbody></table></div></section>`;
  document.querySelector("#template").value = config.template;
  document.querySelector("#locales").value = config.locales.join(",");
  document.querySelector("#module").value = (config.modules ?? ["directory"])
    .length
    ? "on"
    : "off";
  let imported = local?.imported ?? null,
    fileGeneration = 0,
    filePending = false;
  const configEditor = document.querySelector("#config");
  const fields = [...workspace.querySelectorAll("input, select, textarea")];
  const controls = [
    ...workspace.querySelectorAll("button, input, select, textarea"),
  ];
  const refresh = workspace.querySelector("#refresh-config");
  const loadServer = workspace.querySelector("#load-server-config");
  const baseText = JSON.stringify(config, null, 2);
  const reads = new Set();
  let pending = false,
    committed = "",
    recovery,
    operationGeneration = 0;
  const active = () => scope.current() && configEditor.isConnected;
  const capture = () => ({
    imported,
    version: {
      revision: data.state.revision,
      draftVersion: data.state.draft_version,
    },
    fields: Object.fromEntries(
      fields.map((field) => [
        field.id,
        {
          value: field.value,
          checked: field.checked,
        },
      ]),
    ),
    expanded: workspace.querySelector("details").open,
  });
  const dirty = () =>
    imported !== null ||
    configEditor.value !== baseText ||
    workspace.querySelector("#replace").checked;
  if (local) {
    for (const field of fields) {
      const value = local.fields[field.id];
      if (!value || field.type === "file") continue;
      field.value = value.value;
      if (value.checked !== undefined) field.checked = value.checked;
    }
    workspace.querySelector("details").open = local.expanded;
    const changedVersion =
      local.version &&
      (local.version.revision !== data.state.revision ||
        local.version.draftVersion !== data.state.draft_version);
    // Draft replacement consent belongs to the version the operator reviewed.
    if (changedVersion) workspace.querySelector("#replace").checked = false;
    workspace.querySelector("#config-local-state").textContent = changedVersion
      ? "未保存的编辑已保留。版本已更新，请重新比较并确认替换草稿。"
      : "未保存的编辑仍在本页，尚未保存。";
  }
  const update = () => {
    if (!active()) return;
    for (const control of controls)
      control.disabled =
        pending ||
        reads.has(control) ||
        (Boolean(committed) && control !== refresh && control !== loadServer);
  };
  const acknowledged = () =>
    committed + (recovery ? "未保存的编辑已保留。" : "");
  const reload = async (saved) => {
    sites = await api("/sites");
    await edit(id, scope, saved);
  };
  const refreshError = (error) =>
    notice(
      acknowledged() +
        (committed ? "但页面刷新失败：" : "页面刷新失败：") +
        error.message +
        "。可刷新配置确认状态，或载入服务器配置。",
      true,
    );
  // Read-only comparisons keep editing available. Their completion must not
  // re-enable controls while a write or recovery read holds the page.
  const bind = (name, fn) => {
    const button = workspace.querySelector("#" + name);
    button.addEventListener("click", async () => {
      if (!active() || pending || committed || reads.has(button)) return;
      const generation = operationGeneration;
      reads.add(button);
      update();
      try {
        await fn(generation);
      } catch (error) {
        if (active() && generation === operationGeneration)
          notice(error.message, true);
      } finally {
        reads.delete(button);
        update();
      }
    });
  };
  const readPage = async (discard) => {
    if (!active() || pending) return;
    if (filePending) {
      notice("配置文件仍在读取或校验，请稍后再试。", true);
      return;
    }
    const saved = discard
      ? undefined
      : committed
        ? recovery
        : dirty()
          ? capture()
          : undefined;
    pending = true;
    fileGeneration++;
    operationGeneration++;
    update();
    notice(committed ? acknowledged() : "");
    try {
      await reload(saved);
      notice(
        committed +
          (saved
            ? "未保存的编辑仍保留。"
            : discard
              ? "已载入服务器配置。"
              : "配置已刷新。"),
      );
    } catch (error) {
      refreshError(error);
    } finally {
      pending = false;
      update();
    }
  };
  refresh.addEventListener("click", () => readPage(false));
  loadServer.addEventListener("click", () => readPage(true));
  const change = async (path, input, success, preserve = false) => {
    if (!active() || pending || committed) return;
    if (filePending) {
      notice("配置文件仍在读取或校验，请稍后再试。", true);
      return;
    }
    const saved = preserve && dirty() ? capture() : undefined;
    pending = true;
    fileGeneration++;
    operationGeneration++;
    update();
    notice("");
    try {
      await api("/sites/" + id + "/" + path, input());
    } catch (error) {
      notice(error.message, true);
      pending = false;
      update();
      return;
    }
    committed = success;
    recovery = saved;
    notice(acknowledged());
    try {
      await reload(saved);
    } catch (error) {
      refreshError(error);
    } finally {
      pending = false;
      update();
    }
  };

  const currentFile = (generation) =>
    scope.current() &&
    generation === fileGeneration &&
    document.querySelector("#config") === configEditor;
  const edited = () => {
    fileGeneration++;
    document.querySelector("#diff").textContent = "";
    if (filePending) notice("已保留当前编辑内容，取消尚未完成的文件载入。");
    filePending = false;
  };
  const candidate = () => {
    if (filePending) throw new Error("配置文件仍在读取或校验，请稍后再试。");
    return {
      ...imported,
      schemaVersion: imported?.schemaVersion ?? 1,
      kind: imported?.kind ?? "published",
      siteId: imported?.siteId ?? id,
      baseRevision: imported?.baseRevision ?? data.state.revision,
      config: JSON.parse(document.querySelector("#config").value),
    };
  };
  const expected = {
    revision: data.state.revision,
    draftVersion: data.state.draft_version,
  };
  const publishOperation = crypto.randomUUID();
  const populate = (value) => {
    document.querySelector("#opensource").checked =
      value.modules?.includes("opensource") ?? false;
    if (value.template)
      document.querySelector("#template").value = value.template;
    document.querySelector("#name").value =
      typeof value.name === "string" ? value.name : "";
    document.querySelector("#tagline").value =
      typeof value.tagline === "string" ? value.tagline : "";
    document.querySelector("#locales").value = Array.isArray(value.locales)
      ? value.locales.join(",")
      : "";
    document.querySelector("#module").value = (value.modules ?? ["directory"])
      .length
      ? "on"
      : "off";
  };
  for (const field of [
    "name",
    "tagline",
    "locales",
    "module",
    "template",
    "opensource",
  ]) {
    document.querySelector("#" + field).addEventListener("input", (event) => {
      edited();
      try {
        const value = JSON.parse(document.querySelector("#config").value);
        value[
          field === "module" || field === "opensource" ? "modules" : field
        ] =
          field === "locales"
            ? event.target.value.split(",")
            : field === "module" || field === "opensource"
              ? document.querySelector("#module").value === "on"
                ? [
                    "directory",
                    ...(document.querySelector("#opensource").checked
                      ? ["opensource"]
                      : []),
                  ]
                : []
              : event.target.value;
        document.querySelector("#config").value = JSON.stringify(
          value,
          null,
          2,
        );
      } catch {
        notice("请先修复配置 JSON 的格式，再修改表单。", true);
      }
    });
  }
  document.querySelector("#config").addEventListener("input", (event) => {
    edited();
    try {
      populate(JSON.parse(event.target.value));
    } catch {
      /* Keep incomplete JSON in the editor; save reports validation errors. */
    }
  });
  document
    .querySelector("#import")
    .addEventListener("change", async (event) => {
      const generation = ++fileGeneration;
      filePending = false;
      document.querySelector("#diff").textContent = "";
      try {
        const file = event.target.files[0];
        if (!file) {
          notice("已取消文件选择，保留当前编辑内容。");
          return;
        }
        filePending = true;
        notice("正在读取并校验配置文件…");
        if (file.size > 262144) throw new Error("配置文件不能超过 256 KiB");
        const snapshot = JSON.parse(await file.text());
        if (!currentFile(generation)) return;
        await api("/sites/" + id + "/compare", { snapshot });
        if (!currentFile(generation)) return;
        imported = snapshot;
        document.querySelector("#config").value = JSON.stringify(
          snapshot.config,
          null,
          2,
        );
        populate(snapshot.config);
        notice("已选择文件，请先校验差异；尚未保存。");
      } catch (error) {
        if (currentFile(generation)) notice(error.message, true);
      } finally {
        if (currentFile(generation)) filePending = false;
      }
    });
  bind("compare", async () => {
    const generation = fileGeneration;
    let result;
    try {
      result = await api("/sites/" + id + "/compare", {
        snapshot: candidate(),
      });
    } catch (error) {
      if (currentFile(generation)) throw error;
      return;
    }
    if (!currentFile(generation)) return;
    document.querySelector("#diff").textContent = JSON.stringify(
      result,
      null,
      2,
    );
    notice(
      result.stale
        ? "基础版本已过期，请重新导出比较。"
        : "校验通过。请检查差异，再保存草稿。",
      result.stale,
    );
  });
  workspace.querySelector("#save").addEventListener("click", () =>
    change(
      "save",
      () => ({
        snapshot: candidate(),
        expected,
        replace: workspace.querySelector("#replace").checked,
      }),
      "草稿已保存。",
    ),
  );
  workspace.querySelector("#publish").addEventListener("click", () =>
    change(
      "publish",
      () => ({
        expected,
        operationId: publishOperation,
      }),
      "发布成功。",
      true,
    ),
  );
  bind("export", async (generation) => {
    const snapshot = await api("/sites/" + id + "/export");
    if (!active() || generation !== operationGeneration) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json",
      }),
    );
    link.download = id + ".json";
    link.click();
    URL.revokeObjectURL(link.href);
  });
  bind("preview", async () => {
    window.open("/admin/api/sites/" + id + "/preview", "_blank", "noopener");
  });
  workspace.querySelector("#toggle").addEventListener("click", () =>
    change(
      "status",
      () => ({
        active: !data.site.active,
      }),
      "站点状态已更新。",
      true,
    ),
  );
  for (const button of workspace.querySelectorAll(".rollback"))
    button.addEventListener("click", () =>
      change(
        "rollback",
        () => ({
          revision: Number(button.dataset.revision),
          expected,
        }),
        "历史修订已恢复为草稿，检查后可重新发布。",
        true,
      ),
    );
  update();
}
async function team(scope, draft) {
  const { api, notice } = scope;
  const users = await api("/operators");
  workspace.innerHTML = `<h1>成员与权限</h1><p class="muted">站群管理员管理全部站点。其他成员只获得明确授予的站点权限。</p><button class="secondary" id="refresh-team">刷新列表</button><section class="panel"><div class="table-wrap"><table><tr><th>邮箱</th><th>权限</th><th>状态</th></tr>${users.map((u) => `<tr><td>${escape(u.email)}</td><td>${u.global_admin ? "站群管理员" : escape(u.grants || "未分配")}</td><td>${u.disabled ? "已停用" : "启用"}</td></tr>`).join("")}</table></div></section><section class="panel"><h2>添加成员</h2><label for="member-email">邮箱</label><input id="member-email" type="email"><label for="member-password">初始密码（至少 12 字符）</label><input id="member-password" type="password"><div class="actions"><button id="add-member">添加</button></div><h2>分配站点权限</h2><label for="member">成员</label><select id="member">${users.map((u) => `<option value="${u.id}">${escape(u.email)}</option>`).join("")}</select><label for="grant-site">站点</label><select id="grant-site">${sites.map((s) => `<option value="${s.id}">${escape(s.config.name)}</option>`).join("")}</select><label for="role">角色</label><select id="role"><option value="viewer">只读</option><option value="editor">编辑与发布</option></select><div class="actions"><button id="grant">保存权限</button><button id="revoke" class="secondary">撤销此站权限</button></div></section><section class="panel"><h2>账号安全</h2><label for="account-member">成员</label><select id="account-member">${users.map((u) => `<option value="${u.id}">${escape(u.email)}</option>`).join("")}</select><label for="account-password">新密码（至少 12 字符）</label><input id="account-password" type="password" autocomplete="new-password"><div class="actions"><button id="set-password">设置密码并撤销会话</button><button id="enable-member">启用</button><button id="disable">停用</button><button id="revoke-sessions" class="secondary">撤销全部会话</button></div></section>`;
  const fields = Object.fromEntries(
    ["member-email", "member-password", "member", "grant-site", "role", "account-member"].map(
      (id) => [id, workspace.querySelector("#" + id)],
    ),
  );
  if (draft)
    for (const [id, field] of Object.entries(fields)) field.value = draft[id];
  const capture = () =>
    Object.fromEntries(
      Object.entries(fields).map(([id, field]) => [id, field.value]),
    );
  const buttons = [
    "add-member",
    "grant",
    "revoke",
    "set-password",
    "enable-member",
    "disable",
    "revoke-sessions",
  ].map((id) => workspace.querySelector("#" + id));
  const [
    addMember,
    grant,
    revoke,
    setPassword,
    enableMember,
    disableMember,
    revokeSessions,
  ] = buttons;
  const accountPassword = workspace.querySelector("#account-password");
  const refresh = workspace.querySelector("#refresh-team");
  let pending = false,
    committed = "";
  const active = () => scope.current() && refresh.isConnected;
  const update = () => {
    if (!active()) return;
    for (const control of [
      ...buttons,
      ...Object.values(fields),
      accountPassword,
    ])
      control.disabled = pending || Boolean(committed);
    refresh.disabled = pending;
  };
  const refreshError = (error) =>
    notice(
      committed +
        (committed ? "但列表刷新失败：" : "列表刷新失败：") +
        error.message +
        "。请刷新列表确认状态。",
      true,
    );
  refresh.addEventListener("click", async () => {
    if (pending || !active()) return;
    const values = capture();
    pending = true;
    update();
    notice("");
    try {
      await team(scope, values);
    } catch (error) {
      refreshError(error);
    } finally {
      pending = false;
      update();
    }
  });
  const change = async (path, input, success, clearMember = false) => {
    if (pending || committed || !active()) return;
    pending = true;
    update();
    notice("");
    try {
      await api(path, input);
    } catch (error) {
      notice(error.message, true);
      pending = false;
      update();
      return;
    }
    committed = success;
    if (clearMember) {
      // Clear acknowledged creation credentials before the following read.
      fields["member-email"].value = "";
      fields["member-password"].value = "";
    }
    notice(success);
    try {
      await team(scope, capture());
    } catch (error) {
      refreshError(error);
    } finally {
      pending = false;
      update();
    }
  };
  const selection = () => ({
    userId: fields.member.value,
    siteId: fields["grant-site"].value,
  });
  addMember.addEventListener("click", () =>
    change(
      "/operators",
      {
        email: fields["member-email"].value,
        password: fields["member-password"].value,
      },
      "成员已添加。",
      true,
    ),
  );
  grant.addEventListener("click", () =>
    change(
      "/grants",
      {
        ...selection(),
        role: fields.role.value,
      },
      "权限已更新。",
    ),
  );
  revoke.addEventListener("click", () =>
    change("/grants/revoke", selection(), "权限已撤销。"),
  );
  setPassword.addEventListener("click", () => {
    const userId = fields["account-member"].value;
    const password = accountPassword.value;
    accountPassword.value = "";
    return change(
      "/operators/password",
      { userId, password },
      "密码已更新，该成员会话已撤销。",
    );
  });
  enableMember.addEventListener("click", () =>
    change(
      "/operators/enable",
      { userId: fields["account-member"].value },
      "成员已启用。",
    ),
  );
  disableMember.addEventListener("click", () =>
    change(
      "/operators/disable",
      { userId: fields["account-member"].value },
      "成员已停用，相关会话已撤销。",
    ),
  );
  revokeSessions.addEventListener("click", () =>
    change(
      "/operators/revoke-sessions",
      { userId: fields["account-member"].value },
      "该成员的全部会话已撤销。",
    ),
  );
}
const auditLabels = {
  "operator.create": "创建成员",
  "operator.grant": "授予站点权限",
  "operator.revoke": "撤销站点权限",
  "operator.disable": "停用成员",
  "operator.enable": "启用成员",
  "operator.password": "重置成员密码",
  "operator.session.revoke": "撤销成员会话",
  "site.create": "创建站点",
  "site.status": "启停站点",
  "config.save": "保存配置",
  "config.publish": "发布配置",
  "config.rollback": "回滚配置",
  "resource.save": "保存资源主档",
  "resource.import": "导入资源主档",
  "category.save": "保存分类",
  "publication.stage": "暂存站点发布",
  "publication.publish": "发布站点内容",
  "publication.unpublish": "下架站点内容",
  "submission.review": "审核投稿",
  "github.source.save": "保存 GitHub 来源",
  "github.sync.enqueue": "排队 GitHub 同步",
  "github.candidate.review": "审核 GitHub 候选",
  "github.stats": "自动更新项目统计",
  "auth.provider.set": "配置登录提供方",
  "auth.retry": "重试账号准备",
  "task.retry": "重试运行任务",
};
function auditDetail(detail) {
  if (!detail || typeof detail !== "object" || !Object.keys(detail).length)
    return "—";
  return JSON.stringify(detail);
}
async function audit(scope) {
  const { api, notice } = scope;
  const global = Boolean(me.global_admin);
  const choices = global
    ? [{ id: "", name: "全部站点" }, ...sites]
    : sites;
  if (!choices.length) {
    workspace.innerHTML =
      '<h1>审计日志</h1><p class="muted">当前账号没有可查看的站点权限。</p>';
    return;
  }
  workspace.innerHTML = `<h1>审计日志</h1><p class="muted">只读记录管理操作、内容发布、账号与运行任务；详情不包含密钥。最新 50 条，可继续向前加载。</p><div class="row"><label for="audit-site">站点</label><select id="audit-site">${choices.map((site) => `<option value="${escape(site.id)}">${escape(site.name ?? site.config?.name ?? site.id)}</option>`).join("")}</select><button class="secondary" id="audit-refresh">刷新</button></div><div id="audit-list"><p class="muted">正在加载…</p></div><button class="secondary" id="audit-more" hidden>加载更多</button>`;
  const select = workspace.querySelector("#audit-site"),
    list = workspace.querySelector("#audit-list"),
    more = workspace.querySelector("#audit-more"),
    refresh = workspace.querySelector("#audit-refresh");
  let before = null,
    busy = false;
  const rows = (events) =>
    events
      .map(
        (event) =>
          `<tr><td>${escape(new Date(event.created_at).toLocaleString("zh-CN", { hour12: false }))}</td><td>${escape(event.actor_email ?? "—")}</td><td>${escape(event.site_id ?? "全局")}</td><td>${escape(auditLabels[event.action] ?? event.action)}<br><small>${escape(event.action)}</small></td><td><code>${escape(auditDetail(event.detail))}</code></td></tr>`,
      )
      .join("");
  const load = async (append = false) => {
    if (busy || !scope.current()) return;
    busy = true;
    refresh.disabled = true;
    more.disabled = true;
    try {
      const site = select.value;
      const data = await api(
        "/audit?limit=50" +
          (site ? "&site=" + encodeURIComponent(site) : "") +
          (append && before ? "&before=" + encodeURIComponent(before) : ""),
      );
      if (!scope.current()) return;
      const body = rows(data.events) || '<tr><td colspan="5" class="muted">暂无记录</td></tr>';
      if (append) {
        const tbody = list.querySelector("tbody");
        if (tbody) tbody.insertAdjacentHTML("beforeend", body);
      } else {
        list.innerHTML = `<section class="panel"><div class="table-wrap"><table><thead><tr><th>时间</th><th>操作者</th><th>站点</th><th>操作</th><th>详情</th></tr></thead><tbody>${body}</tbody></table></div></section>`;
      }
      before = data.nextBefore;
      more.hidden = !before;
      notice("");
    } catch (error) {
      notice("审计日志加载失败：" + error.message, true);
    } finally {
      busy = false;
      refresh.disabled = false;
      more.disabled = false;
    }
  };
  select.addEventListener("change", () => {
    before = null;
    more.hidden = true;
    void load(false);
  });
  refresh.addEventListener("click", () => {
    before = null;
    void load(false);
  });
  more.addEventListener("click", () => void load(true));
  await load(false);
}
async function tasks(scope) {
  const { api, notice } = scope;
  const data = await api("/tasks");
  workspace.innerHTML = `<h1>运行任务</h1><p class="muted">配置发布与账号准备任务的持久化状态。仅失败任务可以重新排队。</p><button class="secondary" id="refresh-tasks">刷新列表</button><section class="panel"><h2>账号服务</h2><div class="table-wrap"><table><tr><th>站点</th><th>状态</th><th>尝试次数</th><th>操作</th></tr>${data.instances.map((i) => `<tr><td>${escape(i.site_id)}</td><td>${escape(i.state)} ${escape(i.error_code || "")}</td><td>${i.attempts}</td><td>${i.state === "failed" ? `<button class="secondary retry" data-site="${escape(i.site_id)}">重试</button>` : "—"}</td></tr>`).join("")}</table></div><h2>发布事件</h2><pre>${escape(JSON.stringify(data.events, null, 2))}</pre><h2>已投递修订</h2><pre>${escape(JSON.stringify(data.delivery, null, 2))}</pre>${data.eventFailures.map((e) => `<p>${escape(e.site_id)} · 修订 ${e.revision} · ${escape(e.last_error)} <button class="secondary retry-event" data-event="${e.id}">重试发布事件</button></p>`).join("")}<h2>邮件任务</h2><pre>${escape(JSON.stringify(data.mail, null, 2))}</pre><h2>GitHub 同步任务</h2><pre>${escape(JSON.stringify(data.github, null, 2))}</pre><a href="#github">查看来源与审核候选 →</a><h2>最近维护</h2><pre>${escape(JSON.stringify(data.maintenance, null, 2))}</pre></section>`;
  const retries = [...workspace.querySelectorAll(".retry, .retry-event")];
  const refresh = workspace.querySelector("#refresh-tasks");
  let pending = false,
    committed = false;
  const active = () => scope.current() && refresh.isConnected;
  const update = () => {
    if (!active()) return;
    for (const button of retries) button.disabled = pending || committed;
    refresh.disabled = pending;
  };
  const refreshError = (error, success = "") => {
    notice(
      (success || (committed ? "重试已重新排队。" : "")) +
        (success || committed ? "但列表刷新失败：" : "列表刷新失败：") +
        error.message +
        "。请刷新列表确认状态。",
      true,
    );
  };
  refresh.addEventListener("click", async () => {
    if (pending || !active()) return;
    pending = true;
    update();
    notice("");
    try {
      await tasks(scope);
    } catch (error) {
      refreshError(error);
    } finally {
      pending = false;
      update();
    }
  });
  const retry = async (path, input, success) => {
    if (pending || committed || !active()) return;
    pending = true;
    update();
    try {
      await api(path, input);
    } catch (error) {
      notice(error.message, true);
      pending = false;
      update();
      return;
    }
    // A successful mutation stays acknowledged even if the following GET fails.
    // Keep stale action buttons disabled until a fresh list confirms eligibility.
    committed = true;
    notice(success);
    try {
      await tasks(scope);
    } catch (error) {
      refreshError(error, success);
    } finally {
      pending = false;
      update();
    }
  };
  for (const button of retries)
    button.addEventListener("click", () =>
      button.classList.contains("retry-event")
        ? retry(
            "/tasks/retry-event",
            { id: button.dataset.event },
            "发布事件已重新排队。",
          )
        : retry(
            "/tasks/retry",
            { siteId: button.dataset.site },
            "已重新排队。",
          ),
    );
}
