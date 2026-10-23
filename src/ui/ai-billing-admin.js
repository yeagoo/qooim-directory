const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const number = (value) => Number(value ?? 0).toLocaleString("zh-CN");
const signed = (value) => (value > 0 ? "+" : "") + number(value);
const time = (value) => (value ? new Date(value).toLocaleString("zh-CN") : "—");
const ALERT = "color:#a34c35;font-weight:600";
const POLLS = 6,
  POLL_MS = 2000;
const errorLabels = {
  no_ai_config: "本站尚未配置 AI API Key",
  key_unavailable: "无法解密 API Key",
  unsafe_address: "地址解析到私网或不安全",
  dns_failed: "域名解析失败",
  timeout: "请求超时",
  response_too_large: "响应超过 64 KiB",
  invalid_json: "响应不是 JSON",
  field_missing: "响应中没有该字段",
  not_a_number: "字段不是数字",
  request_failed: "请求失败",
};
const errorText = (code) =>
  errorLabels[code] || (/^http_\d+$/.test(code) ? "HTTP " + code.slice(5) : code);

function reconcileRow(m) {
  const p = m.provider;
  const alert = m.diffPercent !== null && Math.abs(m.diffPercent) > 5;
  const percent =
    m.diffPercent === null ? "—" : (m.diffPercent > 0 ? "+" : "") + m.diffPercent + "%";
  return `<tr data-month="${escape(m.month)}"${alert ? ' data-alert="true"' : ""}><td>${escape(m.month)}</td><td>${number(m.app.jobs)}</td><td>${number(m.app.tokensIn)} / ${number(m.app.tokensOut)}<br><strong>${number(m.app.total)}</strong></td><td>${p ? `${number(p.tokensIn)} / ${number(p.tokensOut)}<br><strong>${number(p.total)}</strong>` : '<span class="muted">未登记</span>'}</td><td class="diff-total">${m.diff ? signed(m.diff.total) : "—"}</td><td class="diff-percent"${alert ? ` style="${ALERT}"` : ""}>${escape(percent)}</td><td>${p ? `${escape(p.note || "—")}<br><span class="muted">${escape(p.reportedBy ?? "—")} · ${escape(time(p.reportedAt))}</span>` : "—"}</td></tr>`;
}
function reconcileTable(data) {
  return `<div class="table-wrap"><table id="ai-reconcile"><thead><tr><th>月份</th><th>任务</th><th>本系统 输入 / 输出<br>合计</th><th>供应商 输入 / 输出<br>合计</th><th>差异（供应商 − 本系统）</th><th>差异比例</th><th>备注 / 登记</th></tr></thead><tbody>${data.months.map(reconcileRow).join("")}</tbody></table></div>`;
}
function balanceState(balance) {
  if (!balance.configured) return "尚未配置余额检查。";
  const parts = [balance.enabled ? "已启用" : "已停用"];
  parts.push(
    "余额：" + (balance.value === null ? "未知" : balance.value.toLocaleString("zh-CN")),
  );
  parts.push("上次检查：" + time(balance.checkedAt));
  if (balance.requestedAt) parts.push("检查排队中…");
  if (balance.error) parts.push("错误：" + errorText(balance.error));
  return parts.join(" · ");
}
// UI hint only; the server enforces every permission. Without access info
// (older callers) the page shows every action.
const READ_ONLY_NOTE = "只读：可以查看对账和余额，不能登记用量或修改余额设置。";
export async function renderAiBilling(site, workspace, api, notice, access) {
  const write = access ? Boolean(access.write) : true;
  const off = write ? "" : " disabled";
  const query = "?site=" + encodeURIComponent(site);
  const [reconcile, balance] = await Promise.all([
    api("/ai/reconcile" + query),
    api("/ai/balance" + query),
  ]);
  const current = reconcile.months[0]?.month ?? "";
  workspace.innerHTML = `<a href="#site/${encodeURIComponent(site)}">← 站点配置</a> · <a href="#ai/${encodeURIComponent(site)}">AI 设置</a><span class="eyebrow"> / 对账</span><h1>AI 用量对账与余额 · ${escape(site)}</h1><p class="muted">把供应商账单里的 token 数登记到这里，与本系统记录的用量（含已汇总的旧任务）逐月对比。登记的数字只用于对账，不会修改预算或任务记录。</p>${write ? "" : `<p class="muted access-note" id="access-note">${escape(READ_ONLY_NOTE)}</p>`}<section class="panel" id="reconcile-panel"><h2>近 12 个月对账</h2><div id="reconcile-table">${reconcileTable(reconcile)}</div><p class="muted">差异比例 = (供应商合计 − 本系统合计) / 本系统合计；超过 ±5% 的月份会标红。本系统没有用量或供应商未登记时不计算比例。</p></section>${write ? `<section class="panel"><h2>登记供应商用量</h2><div class="split"><div><label for="reconcile-month">月份（YYYY-MM）</label><input id="reconcile-month" value="${escape(current)}" placeholder="2026-10" maxlength="7"><label for="reconcile-note">备注</label><input id="reconcile-note" maxlength="500" placeholder="例如：账单编号"></div><div><label for="reconcile-in">输入 token</label><input id="reconcile-in" type="number" min="0" step="1" value="0"><label for="reconcile-out">输出 token</label><input id="reconcile-out" type="number" min="0" step="1" value="0"></div></div><div class="actions"><button id="save-reconcile">保存本月数据</button></div><details><summary>批量导入 CSV</summary><p class="muted">表头 <code>month,tokens_in,tokens_out[,note]</code>，最多 120 行、64 KiB。任一行有误则整批不导入；已登记的月份会被覆盖。</p><label for="reconcile-csv">CSV 内容</label><textarea id="reconcile-csv" spellcheck="false" placeholder="month,tokens_in,tokens_out,note&#10;2026-09,120000,30000,九月账单"></textarea><div class="actions"><button id="import-reconcile" class="secondary">校验并导入</button></div><ul id="reconcile-errors"></ul></details></section>` : ""}<section class="panel" id="balance-panel"><h2>余额检查（可选）</h2><p class="muted">OpenAI-compatible 协议没有统一的余额接口。可以填写供应商的余额查询地址和 JSON 字段路径，后台任务会用本站 AI 的 API Key 以 GET 请求查询（每 6 小时自动一次）。读不到时显示“未知”。</p><div class="split"><div><label for="balance-url">余额端点（HTTPS）</label><input id="balance-url"${off} value="${escape(balance.url)}" placeholder="https://api.example.com/user/balance"></div><div><label for="balance-field">字段路径</label><input id="balance-field"${off} value="${escape(balance.field)}" placeholder="balance_infos.0.total_balance"><label><input id="balance-enabled"${off} type="checkbox" ${balance.configured ? (balance.enabled ? "checked" : "") : "checked"}>启用余额检查</label></div></div>${write ? `<div class="actions"><button id="save-balance">保存余额设置</button><button id="check-balance" class="secondary"${balance.configured ? "" : " disabled"}>立即检查</button></div>` : ""}<p id="balance-state" class="muted">${escape(balanceState(balance))}</p></section>`;
  const $ = (selector) => workspace.querySelector(selector);
  const panel = $("#balance-panel");
  const active = () => document.body.contains(panel);
  const showReconcile = (data) => {
    $("#reconcile-table").innerHTML = reconcileTable(data);
  };
  const showBalance = (data) => {
    $("#balance-state").textContent = balanceState(data);
    const check = $("#check-balance");
    if (check) check.disabled = !data.configured;
  };
  const guard = async (button, work) => {
    button.disabled = true;
    try {
      await work();
    } catch (error) {
      notice(error.message, true);
    } finally {
      button.disabled = false;
    }
  };
  if (!write) return;
  $("#save-reconcile").addEventListener("click", (event) =>
    guard(event.currentTarget, async () => {
      const note = $("#reconcile-note").value.trim();
      const data = await api("/ai/reconcile", {
        site,
        month: $("#reconcile-month").value.trim(),
        tokensIn: Number($("#reconcile-in").value),
        tokensOut: Number($("#reconcile-out").value),
        ...(note ? { note } : {}),
      });
      showReconcile(data);
      notice("已保存供应商用量。");
    }),
  );
  $("#import-reconcile").addEventListener("click", (event) =>
    guard(event.currentTarget, async () => {
      const list = $("#reconcile-errors");
      list.innerHTML = "";
      const response = await fetch("/admin/api/ai/reconcile/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ site, csv: $("#reconcile-csv").value }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) location.assign("/admin/login");
        list.innerHTML = (data.errors ?? [])
          .map((e) => `<li>${e.row ? `第 ${e.row} 行：` : ""}${escape(e.message)}</li>`)
          .join("");
        throw new Error(data.error || "导入失败");
      }
      showReconcile(data);
      notice(`已导入 ${data.imported} 个月的供应商用量。`);
    }),
  );
  $("#save-balance").addEventListener("click", (event) =>
    guard(event.currentTarget, async () => {
      const data = await api("/ai/balance", {
        site,
        url: $("#balance-url").value.trim(),
        field: $("#balance-field").value.trim(),
        enabled: $("#balance-enabled").checked,
      });
      showBalance(data);
      notice("余额设置已保存。");
    }),
  );
  // The web process only queues the check; poll a few times for the worker's result.
  $("#check-balance").addEventListener("click", (event) =>
    guard(event.currentTarget, async () => {
      let data = await api("/ai/balance/check", { site });
      showBalance(data);
      notice("已请求检查余额，稍后自动刷新。");
      for (let i = 0; i < POLLS && data.requestedAt; i++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (!active()) return;
        data = await api("/ai/balance" + query);
        showBalance(data);
      }
      if (!active()) return;
      if (data.requestedAt) notice("检查仍在排队，请稍后刷新页面。");
      else if (data.error) notice("余额检查失败：" + errorText(data.error), true);
      else notice("余额已更新。");
    }),
  );
}
