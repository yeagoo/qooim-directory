const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const MIB = 1024 * 1024;
const fields = [
  ["limit-media-mib", "mediaBytes", "媒体容量（MiB）", 0, 1048576],
  ["limit-media-files", "mediaFiles", "媒体文件数", 0, 1000000],
  ["limit-collector-sources", "collectorSources", "采集来源数", 0, 1000],
  ["limit-collector-runs", "collectorRunsPerHour", "每小时采集次数（0 为停用）", 0, 10000],
];
const shown = (key, value) =>
  key === "mediaBytes" ? Math.floor(value / MIB) : value;
export async function renderLimits(site, workspace, api, notice, globalAdmin) {
  const limits = await api("/limits?site=" + encodeURIComponent(site));
  const disabled = globalAdmin ? "" : " disabled";
  workspace.innerHTML = `<a href="#site/${encodeURIComponent(site)}">← 站点配置</a><span class="eyebrow"> / 配额</span><h1>站点配额 · ${escape(site)}</h1><p class="muted">配额限制本站新上传的媒体和新建/执行的采集任务；调低配额不会删除已有数据。${globalAdmin ? "只有站群管理员可以修改。" : "只有站群管理员可以修改，当前为只读。"}</p><section class="panel"><div class="split">${fields
    .map(
      ([id, key, label, min, max]) =>
        `<div><label for="${id}">${label}</label><input id="${id}" type="number" min="${min}" max="${max}" step="1" value="${shown(key, limits[key])}"${disabled}></div>`,
    )
    .join(
      "",
    )}</div>${globalAdmin ? `<div class="actions"><button id="save-limits">保存配额</button><button id="reset-limits" class="secondary">恢复默认</button></div>` : ""}</section>`;
  const save = async (button, body, text) => {
    button.disabled = true;
    try {
      await api("/limits", { site, ...body });
      await renderLimits(site, workspace, api, notice, globalAdmin);
      notice(text);
    } catch (error) {
      notice(error.message, true);
    } finally {
      button.disabled = false;
    }
  };
  workspace.querySelector("#save-limits")?.addEventListener("click", (event) => {
    const body = {};
    for (const [id, key] of fields) {
      const value = Number(workspace.querySelector("#" + id).value);
      body[key] = key === "mediaBytes" ? value * MIB : value;
    }
    void save(event.currentTarget, body, "配额已保存。");
  });
  workspace.querySelector("#reset-limits")?.addEventListener("click", (event) =>
    save(
      event.currentTarget,
      Object.fromEntries(fields.map(([, key]) => [key, null])),
      "已恢复默认配额。",
    ),
  );
}
