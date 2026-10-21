const data = JSON.parse(
  document.querySelector("#account-home-data").textContent,
);
const linked = document.querySelector("#linked-accounts"),
  linkBox = document.querySelector("#link-providers"),
  passkeys = document.querySelector("#passkeys"),
  passkeyName = document.querySelector("#passkey-name"),
  addPasskey = document.querySelector("#add-passkey"),
  message = document.querySelector("#message");
const labels = new Map(data.providers.map((provider) => [provider.id, provider.label]));
let busy = false,
  accounts = [];

function notice(text, error = false) {
  message.textContent = text;
  message.className = "notice" + (error ? " error" : "");
}
function providerLabel(id) {
  return labels.get(id) ?? id;
}
async function request(path, body) {
  const response = await fetch("/api/auth/" + path, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // An intermediary may return an HTML error page.
  }
  if (!response.ok)
    throw new Error(
      payload?.message ||
        payload?.error ||
        `请求失败（HTTP ${response.status}）`,
    );
  return payload;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function setBusy(value) {
  busy = value;
  for (const button of document.querySelectorAll("button")) button.disabled = value;
}
function render() {
  linked.replaceChildren();
  linked.append(element("h3", "", "已绑定的登录方式"));
  const list = element("div", "linked-list");
  for (const account of accounts) {
    const row = element("div", "linked-row");
    const left = element("div");
    const name =
      account.providerId === "credential"
        ? "邮箱和密码"
        : providerLabel(account.providerId);
    left.append(
      element("strong", "", name),
      element(
        "div",
        "muted",
        account.providerId === "credential"
          ? data.email
          : "第三方账号",
      ),
    );
    row.append(left);
    if (account.providerId !== "credential") {
      const remove = element("button", "secondary", "解除绑定");
      remove.type = "button";
      remove.dataset.account = account.id;
      remove.addEventListener("click", () => unlink(account));
      row.append(remove);
    }
    list.append(row);
  }
  linked.append(list);

  linkBox.replaceChildren();
  linkBox.append(element("h3", "", "绑定其他登录方式"));
  if (!data.providers.length) {
    linkBox.append(
      element("p", "muted", "管理员尚未配置可绑定的第三方登录。"),
    );
  } else {
    const available = data.providers.filter(
      (provider) =>
        !accounts.some((account) => account.providerId === provider.id),
    );
    if (!available.length) {
      linkBox.append(element("p", "muted", "所有已配置的登录方式都已绑定。"));
    } else {
      const group = element("div", "provider-list");
      for (const provider of available) {
        const button = element(
          "button",
          "secondary",
          `绑定 ${provider.label}`,
        );
        button.type = "button";
        button.dataset.provider = provider.id;
        button.addEventListener("click", () => link(provider));
        group.append(button);
      }
      linkBox.append(group);
    }
  }
}
function passkeySupported() {
  return Boolean(
    window.PublicKeyCredential && window.SimpleWebAuthnBrowser,
  );
}
function renderPasskeys(items) {
  passkeys.replaceChildren();
  if (!items.length) {
    passkeys.append(
      element("p", "muted", "还没有 Passkey。添加后可用设备生物识别或 PIN 登录。"),
    );
    return;
  }
  const list = element("div", "linked-list");
  for (const item of items) {
    const row = element("div", "linked-row");
    const left = element("div");
    left.append(
      element("strong", "", item.name || "Passkey"),
      element(
        "div",
        "muted",
        item.backedUp ? "已同步/备份的凭据" : "仅此设备",
      ),
    );
    const remove = element("button", "secondary", "删除");
    remove.type = "button";
    remove.addEventListener("click", () => deletePasskey(item));
    row.append(left, remove);
    list.append(row);
  }
  passkeys.append(list);
}
async function loadPasskeys() {
  if (!passkeySupported()) {
    passkeys.replaceChildren(
      element("p", "muted", "此浏览器不支持 Passkey。"),
    );
    return;
  }
  try {
    renderPasskeys(await request("passkey/list-user-passkeys"));
  } catch (error) {
    passkeys.replaceChildren(
      element("p", "muted", "Passkey 加载失败：" + error.message),
    );
  }
}
async function addNewPasskey() {
  if (busy || !passkeySupported()) return;
  setBusy(true);
  notice("正在创建 Passkey…");
  try {
    const options = await request("passkey/generate-register-options");
    const response = await window.SimpleWebAuthnBrowser.startRegistration({
      optionsJSON: options,
    });
    await request("passkey/verify-registration", {
      response,
      name: passkeyName.value.trim() || "Passkey",
    });
    passkeyName.value = "";
    notice("Passkey 已添加。");
    await loadPasskeys();
  } catch (error) {
    notice("Passkey 添加失败：" + error.message, true);
  } finally {
    setBusy(false);
  }
}
async function deletePasskey(item) {
  if (busy) return;
  if (!confirm(`删除 Passkey「${item.name || "Passkey"}」？`)) return;
  setBusy(true);
  try {
    await request("passkey/delete-passkey", { id: item.id });
    notice("Passkey 已删除。");
    await loadPasskeys();
  } catch (error) {
    notice("Passkey 删除失败：" + error.message, true);
  } finally {
    setBusy(false);
  }
}
async function load() {
  try {
    accounts = await request("list-accounts");
    render();
  } catch (error) {
    notice(error.message, true);
  }
  await loadPasskeys();
}
async function link(provider) {
  if (busy) return;
  setBusy(true);
  notice("正在前往 " + provider.label + " 授权…");
  try {
    const result = await request("link-social", {
      provider: provider.id,
      callbackURL: location.origin + "/account",
      errorCallbackURL: location.origin + "/account?error=link",
      disableRedirect: true,
    });
    if (!result?.url) throw new Error("没有收到授权地址，请稍后重试。");
    location.assign(result.url);
  } catch (error) {
    notice(error.message, true);
    setBusy(false);
  }
}
async function unlink(account) {
  if (busy) return;
  const label =
    account.providerId === "credential"
      ? "邮箱密码"
      : providerLabel(account.providerId);
  if (!confirm(`解除 ${label} 绑定？`)) return;
  setBusy(true);
  try {
    await request("unlink-account", { accountId: account.id });
    notice("已解除绑定。");
    accounts = await request("list-accounts");
    render();
  } catch (error) {
    notice(error.message, true);
  } finally {
    setBusy(false);
  }
}
if (addPasskey) {
  if (!passkeySupported()) addPasskey.hidden = true;
  addPasskey.addEventListener("click", addNewPasskey);
}
if (new URLSearchParams(location.search).get("error"))
  notice("绑定未完成，请重试。", true);
load();
