const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const number = (value) => Number(value ?? 0).toLocaleString("zh-CN");
function usagePanel(usage) {
  const current = usage.currentMonth;
  const budget = usage.monthlyTokens;
  const percent = budget ? Math.min(100, Math.round((current.used / budget) * 100)) : 0;
  const summary = budget
    ? `已用 ${number(current.used)} / ${number(budget)} token（${percent}%）${current.used >= budget ? " · 本月预算已用完，新任务会被拒绝" : ""}`
    : `已用 ${number(current.used)} token · 尚未配置预算`;
  return `<section class="panel"><h2>用量</h2><p id="ai-usage" class="muted">本月 ${escape(usage.months[0]?.month)} · ${current.jobs} 个任务 · ${summary}</p>${budget ? `<progress id="ai-usage-bar" max="100" value="${percent}">${percent}%</progress>` : ""}<div class="table-wrap"><table id="ai-usage-months"><thead><tr><th>月份</th><th>任务</th><th>输入 token</th><th>输出 token</th><th>合计</th></tr></thead><tbody>${usage.months.map((m) => `<tr><td>${escape(m.month)}</td><td>${number(m.jobs)}</td><td>${number(m.tokensIn)}</td><td>${number(m.tokensOut)}</td><td>${number(m.tokensIn + m.tokensOut)}</td></tr>`).join("")}</tbody></table></div><p class="muted">统计包含全部状态的任务；超过保留期的旧任务会汇总为月度用量后删除，合计不变。</p></section>`;
}
export async function renderAi(site, workspace, api, notice) {
  const [config, usage] = await Promise.all([
    api("/ai/config?site=" + encodeURIComponent(site)),
    api("/ai/usage?site=" + encodeURIComponent(site)),
  ]);
  workspace.innerHTML = `<a href="#site/${encodeURIComponent(site)}">← 站点配置</a><span class="eyebrow"> / AI</span><h1>AI 生成与翻译 · ${escape(site)}</h1><p class="muted">服务端调用 OpenAI-compatible 端点；密钥加密保存，不回显。AI 输出只作为草稿建议，必须人工保存并发布。</p><section class="panel"><h2>供应商配置</h2><div class="split"><div><label for="ai-endpoint">HTTPS 端点</label><input id="ai-endpoint" value="${escape(config.endpoint)}" placeholder="https://api.openai.com/v1/chat/completions"><label for="ai-model">模型</label><input id="ai-model" value="${escape(config.model)}" placeholder="gpt-4.1-mini"></div><div><label for="ai-key">API Key</label><input id="ai-key" type="password" autocomplete="new-password" placeholder="${config.hasKey ? "已保存，留空保持不变" : "首次配置必填"}"><label for="ai-budget">月度 token 预算</label><input id="ai-budget" type="number" min="1000" max="100000000" step="1000" value="${config.monthlyTokens}"><label><input id="ai-enabled" type="checkbox" ${config.enabled ? "checked" : ""}>启用本站 AI</label></div></div><div class="actions"><button id="save-ai">保存配置</button><button id="refresh-ai" class="secondary">刷新</button></div><p id="ai-state" class="muted">${config.hasKey ? "已保存 API Key" : "尚未保存 API Key"} · 更新于 ${escape(config.updatedAt ?? "—")}</p></section>${usagePanel(usage)}<p id="message" role="status" aria-live="polite"></p>`;
  workspace.querySelector("#refresh-ai")?.addEventListener("click", () => renderAi(site, workspace, api, notice));
  workspace.querySelector("#save-ai")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const key = workspace.querySelector("#ai-key").value.trim();
      await api("/ai/config", {
        site,
        endpoint: workspace.querySelector("#ai-endpoint").value.trim(),
        model: workspace.querySelector("#ai-model").value.trim(),
        ...(key ? { key } : {}),
        enabled: workspace.querySelector("#ai-enabled").checked,
        monthlyTokens: Number(workspace.querySelector("#ai-budget").value),
      });
      await renderAi(site, workspace, api, notice);
      notice("AI 配置已保存。");
    } catch (error) {
      notice(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}
