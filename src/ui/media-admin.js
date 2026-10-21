const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const size = (bytes) =>
  bytes > 1024 * 1024
    ? (bytes / 1024 / 1024).toFixed(1) + " MiB"
    : Math.ceil(bytes / 1024) + " KiB";
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let result = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    result += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(result);
}
export async function renderMedia(site, workspace, api, notice) {
  let items = [];
  const draw = () => {
    workspace.innerHTML = `<a href="#site/${encodeURIComponent(site)}">← 站点配置</a><span class="eyebrow"> / MEDIA</span><h1>媒体库 · ${escape(site)}</h1><p class="muted">只支持 JPEG、PNG、WebP；单文件不超过 10 MiB。图片按内容哈希存储，删除前会检查线上/草稿引用。</p><section class="panel"><h2>上传图片</h2><div class="split"><div><label for="media-file">图片文件</label><input id="media-file" type="file" accept="image/jpeg,image/png,image/webp"></div><div><label for="media-alt">替代文本（必填）</label><input id="media-alt" maxlength="200" placeholder="描述图片内容"></div></div><div class="actions"><button id="upload-media">上传</button><button id="refresh-media" class="secondary">刷新</button></div></section><section class="panel"><h2>已上传 ${items.length} 张</h2><div class="grid">${items.map((item) => `<article class="site-card"><img src="${escape(item.adminUrl)}" alt="${escape(item.alt)}" style="width:100%;max-height:180px;object-fit:cover;border-radius:6px"><h2>${escape(item.filename)}</h2><p class="muted">${escape(item.mime)} · ${item.width}×${item.height} · ${size(item.bytes)}</p><p>${escape(item.alt)}</p><div class="actions"><button class="secondary copy-media" data-id="${escape(item.id)}" data-alt="${escape(item.alt)}">复制引用 JSON</button><button class="secondary delete-media" data-id="${escape(item.id)}">删除</button></div></article>`).join("") || '<p class="muted">还没有上传图片。</p>'}</div></section><p id="message" role="status" aria-live="polite"></p>`;
    workspace.querySelector("#refresh-media")?.addEventListener("click", load);
    workspace
      .querySelector("#upload-media")
      ?.addEventListener("click", upload);
    for (const button of workspace.querySelectorAll(".delete-media"))
      button.addEventListener("click", () => remove(button.dataset.id));
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
  };
  const load = async () => {
    try {
      items = await api("/media?site=" + encodeURIComponent(site));
      draw();
    } catch (error) {
      notice(error.message, true);
    }
  };
  const upload = async () => {
    const file = workspace.querySelector("#media-file").files[0],
      alt = workspace.querySelector("#media-alt").value.trim(),
      button = workspace.querySelector("#upload-media");
    if (!file) return notice("请选择图片。", true);
    if (!alt) return notice("请填写替代文本。", true);
    if (file.size > 10 * 1024 * 1024)
      return notice("图片不能超过 10 MiB。", true);
    button.disabled = true;
    notice("正在上传…");
    try {
      await api("/media", {
        site,
        filename: file.name,
        mime: file.type,
        alt,
        data: toBase64(await file.arrayBuffer()),
      });
      await load();
      notice("图片已上传。");
    } catch (error) {
      notice(error.message, true);
    } finally {
      button.disabled = false;
    }
  };
  const remove = async (id) => {
    if (!confirm("删除这张图片？仅未被引用时可删除。")) return;
    try {
      const response = await fetch("/admin/api/media/" + encodeURIComponent(id), {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "删除失败");
      await load();
      notice("图片已删除。");
    } catch (error) {
      notice(error.message, true);
    }
  };
  await load();
}
