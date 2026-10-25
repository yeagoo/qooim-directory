const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const size = (bytes) =>
  bytes >= 1024 * 1024 * 1024
    ? (bytes / 1024 / 1024 / 1024).toFixed(2) + " GiB"
    : bytes > 1024 * 1024
      ? (bytes / 1024 / 1024).toFixed(1) + " MiB"
      : Math.ceil(bytes / 1024) + " KiB";
const percent = (used, limit) =>
  limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
const MAX_BYTES = 10 * 1024 * 1024;
const MIMES = ["image/jpeg", "image/png", "image/webp"];
const when = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value ?? "")
    : date.toLocaleString("zh-CN", { hour12: false });
};
// Alt text suggestion: the filename without its extension.
const altFrom = (name) =>
  String(name)
    .replace(/\.[^.]*$/, "")
    .trim()
    .slice(0, 200);
// Client-side checks shared by single, batch and replace uploads.
function check(file) {
  if (!MIMES.includes(file.type)) return "仅支持 JPEG、PNG 或 WebP 图片";
  if (file.size > MAX_BYTES) return "图片不能超过 10 MiB";
  return "";
}
// Server 413 for quota (as opposed to a single oversized file).
const quotaError = (error) =>
  error.status === 413 && /上限|空间不足|配额/.test(error.message);
function quota(usage) {
  if (!usage) return "";
  const full =
    usage.files >= usage.limitFiles || usage.bytes >= usage.limitBytes;
  return `<section class="panel" id="media-usage"><h2>配额</h2><p>存储空间：${size(usage.bytes)} / ${size(usage.limitBytes)}（${percent(usage.bytes, usage.limitBytes)}%）</p><progress class="meter" max="100" value="${percent(usage.bytes, usage.limitBytes)}" aria-label="存储空间用量"></progress><p>文件数量：${usage.files} / ${usage.limitFiles}（${percent(usage.files, usage.limitFiles)}%）</p><progress class="meter" max="100" value="${percent(usage.files, usage.limitFiles)}" aria-label="文件数量用量"></progress>${full ? '<p class="notice error">已达到配额上限，新图片将无法上传；已有图片不受影响。如需扩容请联系全局管理员。</p>' : ""}</section>`;
}
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let result = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    result += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(result);
}
// Like admin.js api(), but also supports DELETE and keeps the HTTP status on errors.
async function request(method, path, body) {
  const response = await fetch("/admin/api" + path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) location.assign("/admin/login");
    const error = new Error(data.error || "操作失败");
    error.status = response.status;
    throw error;
  }
  return data;
}
const FREEZE_NOTE =
  "替换会生成新版本：草稿立即使用新版本；已发布的页面仍显示发布时的版本，重新发布对应内容后才会切换。";
const STATUS = {
  waiting: "等待",
  uploading: "上传中",
  done: "成功",
  failed: "失败",
  skipped: "未上传",
};
// UI hint only; the server enforces every permission. Without access info
// (older callers) the page shows every action.
const READ_ONLY_NOTE = "只读：可以查看和预览图片及历史版本，不能上传、替换、恢复或删除。";
export async function renderMedia(site, workspace, api, notice, access) {
  const write = access ? Boolean(access.write) : true;
  let items = [],
    usage = null,
    busy = false,
    batch = [],
    batchRunning = false,
    history = null, // { id, media, versions } or null
    replaceId = null;
  const media = (id) => "/media/" + encodeURIComponent(id);
  const $ = (selector) => workspace.querySelector(selector);
  // Disables every action while a request is in flight; buttons rendered with
  // data-locked stay disabled afterwards (e.g. deleting the current version).
  const lock = (on) => {
    busy = on;
    for (const element of workspace.querySelectorAll(
      "button, input, select",
    ))
      element.disabled = on || element.dataset.locked === "1";
  };
  const guarded = async (fn) => {
    if (busy) return;
    lock(true);
    try {
      await fn();
    } catch (error) {
      notice(error.message, true);
    } finally {
      lock(false);
    }
  };
  const itemCard = (item) =>
    `<article class="site-card media-item" data-id="${escape(item.id)}"><img src="${escape(item.adminUrl)}" alt="${escape(item.alt)}" class="media-thumb"><h2>${escape(item.filename)} <span class="badge media-version" title="当前版本">v${Number(item.version) || 1}</span></h2><p class="muted">${escape(item.mime)} · ${item.width}×${item.height} · ${size(item.bytes)}</p><p>${escape(item.alt)}</p><div class="actions"><button class="secondary copy-media" data-id="${escape(item.id)}" data-alt="${escape(item.alt)}">复制引用 JSON</button>${write ? `<button class="secondary replace-media" data-id="${escape(item.id)}">替换图片</button>` : ""}<button class="secondary history-media" data-id="${escape(item.id)}">历史版本</button>${write ? `<button class="secondary release-media" data-id="${escape(item.id)}" title="清除已下架内容对这张图片的引用，之后才能删除">解除下架引用</button><button class="secondary delete-media" data-id="${escape(item.id)}">删除</button>` : ""}</div></article>`;
  const draw = () => {
    workspace.innerHTML = `<a href="#site/${encodeURIComponent(site)}">← 站点配置</a><span class="eyebrow"> / 媒体库</span><h1>媒体库 · ${escape(site)}</h1><p class="muted">只支持 JPEG、PNG、WebP；单文件不超过 10 MiB。图片按内容哈希存储，删除前会检查线上/草稿引用。${escape(FREEZE_NOTE)}</p>${write ? "" : `<p class="muted access-note" id="access-note">${escape(READ_ONLY_NOTE)}</p>`}${quota(usage)}${
      write
        ? '<section class="panel"><h2>上传图片</h2><div class="split"><div><label for="media-file">图片文件</label><input id="media-file" type="file" accept="image/jpeg,image/png,image/webp"></div><div><label for="media-alt">替代文本（必填）</label><input id="media-alt" maxlength="200" placeholder="描述图片内容"></div></div><div class="actions"><button id="upload-media">上传</button><button id="refresh-media" class="secondary">刷新</button></div></section><section class="panel" id="media-batch-panel"></section><section class="panel" id="media-replace" hidden></section>'
        : '<div class="actions"><button id="refresh-media" class="secondary">刷新</button></div>'
    }<section class="panel" id="media-history" hidden></section><section class="panel"><h2>已上传 ${items.length} 张</h2><div class="grid" id="media-list">${items.map(itemCard).join("") || '<p class="muted">还没有上传图片。</p>'}</div></section><p id="message" role="status" aria-live="polite"></p>`;
    $("#refresh-media")?.addEventListener("click", () => guarded(load));
    $("#upload-media")?.addEventListener("click", upload);
    for (const button of workspace.querySelectorAll(".delete-media"))
      button.addEventListener("click", () => remove(button.dataset.id));
    for (const button of workspace.querySelectorAll(".release-media"))
      button.addEventListener("click", () => release(button.dataset.id));
    for (const button of workspace.querySelectorAll(".replace-media"))
      button.addEventListener("click", () => {
        replaceId = button.dataset.id;
        drawReplace();
        $("#media-replace")?.scrollIntoView?.({ block: "nearest" });
      });
    for (const button of workspace.querySelectorAll(".history-media"))
      button.addEventListener("click", () =>
        guarded(() => openHistory(button.dataset.id)),
      );
    for (const button of workspace.querySelectorAll(".copy-media"))
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(
            JSON.stringify({
              mediaId: button.dataset.id,
              alt: button.dataset.alt,
            }),
          );
          notice("引用 JSON 已复制，可粘贴到草稿 overrides.image。");
        } catch {
          notice("复制失败，请手动记录媒体 ID。", true);
        }
      });
    drawBatch();
    drawReplace();
    drawHistory();
    if (busy) lock(true);
  };

  // ---- Batch upload -------------------------------------------------------
  const drawBatch = () => {
    const panel = $("#media-batch-panel");
    if (!panel) return;
    const pending = batch.filter((row) => row.status === "waiting").length;
    panel.innerHTML = `<h2>批量上传</h2><p class="muted">一次选择多张图片，逐个上传并分别计入配额；某个文件失败不影响其他文件，配额不足时停止剩余文件。替代文本默认取文件名，可逐个修改（必填，最多 200 字）。</p><label for="media-batch-files">选择多张图片</label><input id="media-batch-files" type="file" multiple accept="image/jpeg,image/png,image/webp">${
      batch.length
        ? `<div class="table-wrap"><table id="media-batch"><tr><th>文件</th><th>替代文本</th><th>状态</th><th></th></tr>${batch
            .map(
              (row, index) =>
                `<tr class="batch-row" data-index="${index}"><td>${escape(row.file.name)}<br><span class="muted">${size(row.file.size)}</span></td><td><input class="batch-alt" data-index="${index}" maxlength="200" aria-label="${escape(row.file.name)} 的替代文本" value="${escape(row.alt)}"${row.status === "waiting" ? "" : ' data-locked="1" disabled'}></td><td class="batch-status${row.status === "failed" ? " error" : ""}">${escape(STATUS[row.status])}${row.error ? "：" + escape(row.error) : ""}</td><td>${row.status === "waiting" ? `<button class="secondary batch-remove" data-index="${index}">移除</button>` : ""}</td></tr>`,
            )
            .join("")}</table></div>`
        : '<p class="muted">尚未选择文件。</p>'
    }<div class="actions"><button id="start-batch"${pending ? "" : ' data-locked="1" disabled'}>开始上传${pending ? `（${pending}）` : ""}</button><button id="clear-batch" class="secondary"${batch.length && !batchRunning ? "" : ' data-locked="1" disabled'}>清空列表</button></div>`;
    $("#media-batch-files").addEventListener("change", (event) => {
      const input = event.currentTarget;
      for (const file of input.files)
        batch.push({ file, alt: altFrom(file.name), status: "waiting", error: "" });
      input.value = "";
      drawBatch();
    });
    for (const input of panel.querySelectorAll(".batch-alt"))
      input.addEventListener("input", () => {
        batch[Number(input.dataset.index)].alt = input.value;
      });
    for (const button of panel.querySelectorAll(".batch-remove"))
      button.addEventListener("click", () => {
        if (busy) return;
        batch.splice(Number(button.dataset.index), 1);
        drawBatch();
      });
    $("#clear-batch").addEventListener("click", () => {
      if (busy) return;
      batch = [];
      drawBatch();
    });
    $("#start-batch").addEventListener("click", startBatch);
    if (busy) lock(true);
  };
  const startBatch = () =>
    guarded(async () => {
      const rows = batch.filter((row) => row.status === "waiting");
      if (!rows.length) return notice("请先选择要上传的图片。", true);
      const missing = rows.find((row) => !row.alt.trim());
      if (missing)
        return notice(`请填写“${missing.file.name}”的替代文本。`, true);
      const tooLong = rows.find((row) => row.alt.trim().length > 200);
      if (tooLong)
        return notice(`“${tooLong.file.name}”的替代文本超过 200 字。`, true);
      batchRunning = true;
      let ok = 0,
        failed = 0,
        stopped = "";
      for (const row of rows) {
        if (stopped) {
          row.status = "skipped";
          row.error = "配额不足，已停止";
          continue;
        }
        const invalid = check(row.file);
        if (invalid) {
          Object.assign(row, { status: "failed", error: invalid });
          failed++;
          drawBatch();
          continue;
        }
        row.status = "uploading";
        drawBatch();
        notice(`正在上传 ${row.file.name}…`);
        try {
          await request("POST", "/media", {
            site,
            filename: row.file.name,
            mime: row.file.type,
            alt: row.alt.trim(),
            data: toBase64(await row.file.arrayBuffer()),
          });
          Object.assign(row, { status: "done", error: "" });
          ok++;
        } catch (error) {
          Object.assign(row, { status: "failed", error: error.message });
          failed++;
          if (quotaError(error)) stopped = error.message;
        }
        drawBatch();
      }
      batchRunning = false;
      await refresh();
      const summary = `批量上传完成：成功 ${ok} 个，失败 ${failed} 个。`;
      if (stopped)
        notice(`配额不足，已停止上传剩余文件：${stopped}\n${summary}`, true);
      else notice(summary, failed > 0);
    });

  // ---- Replace --------------------------------------------------------------
  const drawReplace = () => {
    const panel = $("#media-replace");
    if (!panel) return;
    const item = write && items.find((entry) => entry.id === replaceId);
    if (!item) {
      replaceId = null;
      panel.hidden = true;
      panel.innerHTML = "";
      return;
    }
    panel.hidden = false;
    panel.innerHTML = `<h2>替换图片 · ${escape(item.filename)} <span class="badge">当前 v${Number(item.version) || 1}</span></h2><p class="notice">${escape(FREEZE_NOTE)}</p><div class="split"><div><label for="replace-file">新图片（JPEG/PNG/WebP，≤10 MiB）</label><input id="replace-file" type="file" accept="image/jpeg,image/png,image/webp"></div><div><label for="replace-alt">新替代文本（可选，留空沿用当前）</label><input id="replace-alt" maxlength="200" placeholder="${escape(item.alt)}"></div></div><div class="actions"><button id="confirm-replace">替换为新版本</button><button id="cancel-replace" class="secondary">取消</button></div>`;
    $("#cancel-replace").addEventListener("click", () => {
      replaceId = null;
      drawReplace();
    });
    $("#confirm-replace").addEventListener("click", replace);
    if (busy) lock(true);
  };
  const replace = () =>
    guarded(async () => {
      const id = replaceId,
        file = $("#replace-file")?.files[0],
        alt = $("#replace-alt")?.value.trim() ?? "";
      if (!id) return;
      if (!file) return notice("请选择新图片。", true);
      const invalid = check(file);
      if (invalid) return notice(invalid + "。", true);
      if (alt.length > 200) return notice("替代文本不能超过 200 字。", true);
      notice("正在替换…");
      const updated = await request("POST", media(id) + "/replace", {
        filename: file.name,
        mime: file.type,
        data: toBase64(await file.arrayBuffer()),
        ...(alt ? { alt } : {}),
      });
      replaceId = null;
      await refresh();
      notice(
        `已替换为 v${updated.version}。草稿已使用新版本；已发布页面在重新发布后才会更新。`,
      );
    });

  // ---- History ----------------------------------------------------------------
  const labels = (version) =>
    [
      version.current ? ["当前", "current"] : null,
      version.published ? ["已发布", "published"] : null,
      version.pinned ? ["被内容引用", "pinned"] : null,
      version.restoredFrom ? [`由 v${version.restoredFrom} 恢复`, "restored"] : null,
    ]
      .filter(Boolean)
      .map(
        ([text, kind]) =>
          `<span class="badge version-label" data-kind="${kind}">${escape(text)}</span>`,
      )
      .join(" ");
  const versionRow = (version) => {
    const why = version.current
      ? "当前版本不能删除；请先把其他版本设为当前版本"
      : version.pinned
        ? "该版本被已发布或曾发布的内容引用，不能删除"
        : "";
    return `<article class="site-card version-row" data-version="${Number(version.version)}"><img src="${escape(version.adminUrl)}" alt="v${Number(version.version)} 预览" loading="lazy" class="media-thumb contain"><h2>v${Number(version.version)} ${labels(version)}</h2><p class="muted">${escape(version.filename)} · ${escape(version.mime)} · ${version.width}×${version.height} · ${size(version.bytes)}</p><p class="muted">${escape(when(version.createdAt))}${version.createdBy ? " · " + escape(version.createdBy) : ""}</p>${write ? `<div class="actions">${version.current ? "" : `<button class="secondary restore-version" data-version="${Number(version.version)}">设为当前版本</button>`}<button class="secondary delete-version" data-version="${Number(version.version)}"${why ? ` data-locked="1" disabled title="${escape(why)}"` : ' title="永久删除此版本的文件"'}>删除此版本</button></div>` : ""}</article>`;
  };
  const drawHistory = () => {
    const panel = $("#media-history");
    if (!panel) return;
    if (!history) {
      panel.hidden = true;
      panel.innerHTML = "";
      return;
    }
    panel.hidden = false;
    panel.innerHTML = `<h2>历史版本 · ${escape(history.media.filename)} <span class="badge">当前 v${Number(history.media.version) || 1}</span></h2><p class="muted">${write ? `设为当前版本会以旧版本内容生成一个新版本，不改动历史。${escape(FREEZE_NOTE)}被内容引用的版本和当前版本不能删除。` : "只读：可以预览各版本，不能恢复或删除。"}</p><div class="grid" id="media-versions">${history.versions.map(versionRow).join("") || '<p class="muted">没有版本记录。</p>'}</div><div class="actions"><button id="close-history" class="secondary">关闭历史</button></div>`;
    $("#close-history").addEventListener("click", () => {
      history = null;
      drawHistory();
    });
    for (const button of panel.querySelectorAll(".restore-version"))
      button.addEventListener("click", () => restore(Number(button.dataset.version)));
    for (const button of panel.querySelectorAll(".delete-version"))
      button.addEventListener("click", () =>
        removeVersion(Number(button.dataset.version)),
      );
    if (busy) lock(true);
  };
  const fetchHistory = async (id) => {
    const data = await api(media(id) + "/versions");
    return { id, media: data.media, versions: data.versions ?? [] };
  };
  const openHistory = async (id) => {
    history = await fetchHistory(id);
    drawHistory();
    $("#media-history")?.scrollIntoView?.({ block: "nearest" });
  };
  const restore = (version) =>
    guarded(async () => {
      if (!history) return;
      const id = history.id;
      const updated = await request(
        "POST",
        `${media(id)}/versions/${version}/restore`,
        {},
      );
      await refresh();
      notice(
        `已将 v${version} 设为当前版本（新版本 v${updated.version}）。已发布页面在重新发布后才会更新。`,
      );
    });
  const removeVersion = (version) =>
    guarded(async () => {
      if (!history) return;
      const id = history.id;
      if (!confirm(`永久删除 v${version}？此操作不可撤销。`)) return;
      try {
        await request("DELETE", `${media(id)}/versions/${version}`);
        notice(`v${version} 已删除。`);
      } catch (error) {
        // 409: the version became current or was pinned meanwhile; refresh to show why.
        if (error.status === 409) notice(error.message, true);
        else throw error;
      }
      await refresh();
    });

  // ---- Library ------------------------------------------------------------------
  const fetchAll = async () => {
    [items, usage] = await Promise.all([
      api("/media?site=" + encodeURIComponent(site)),
      api("/media/usage?site=" + encodeURIComponent(site)),
    ]);
  };
  // Reloads list, quota and the open history panel (if it still exists).
  const refresh = async () => {
    await fetchAll();
    if (history)
      history = items.some((item) => item.id === history.id)
        ? await fetchHistory(history.id)
        : null;
    draw();
  };
  const load = async () => {
    try {
      await refresh();
    } catch (error) {
      notice(error.message, true);
    }
  };
  const upload = () =>
    guarded(async () => {
      const file = $("#media-file").files[0],
        alt = $("#media-alt").value.trim();
      if (!file) return notice("请选择图片。", true);
      if (!alt) return notice("请填写替代文本。", true);
      if (file.size > MAX_BYTES) return notice("图片不能超过 10 MiB。", true);
      notice("正在上传…");
      await api("/media", {
        site,
        filename: file.name,
        mime: file.type,
        alt,
        data: toBase64(await file.arrayBuffer()),
      });
      await refresh();
      notice("图片已上传。");
    });
  const release = (id) =>
    guarded(async () => {
      if (
        !confirm(
          "清除已下架内容对这张图片的引用？这些内容以后重新发布时将不再显示这张图片；线上内容不受影响。",
        )
      )
        return;
      const result = await request("POST", `${media(id)}/release`, {});
      await refresh();
      notice(`已解除 ${result.images + result.logos} 处下架内容引用。`);
    });
  const remove = (id) =>
    guarded(async () => {
      if (!confirm("删除这张图片？仅未被引用时可删除。")) return;
      await request("DELETE", media(id));
      if (history?.id === id) history = null;
      if (replaceId === id) replaceId = null;
      await refresh();
      notice("图片已删除。");
    });
  await load();
}
