const form = document.querySelector("#public-login"),
  message = document.querySelector("#message");
const options = JSON.parse(
  document.querySelector("#account-options").textContent,
);
let busy = false,
  manualStarted = false;
function notice(text, error = false) {
  message.textContent = text;
  message.className = "notice" + (error ? " error" : "");
}
function localReturn() {
  try {
    const url = new URL(
      new URLSearchParams(location.search).get("returnTo") ?? "/",
      location.origin,
    );
    return url.origin === location.origin &&
      /^\/(?!\/)[a-zA-Z0-9/_-]*$/.test(url.pathname)
      ? url.pathname + url.search
      : "/";
  } catch {
    return "/";
  }
}
function signedQuery() {
  return new URLSearchParams(location.search).has("sig")
    ? location.search.slice(1)
    : undefined;
}

async function send(path, body) {
  const response = await fetch("/api/auth/" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // Preserve the status when an intermediary returns an error page.
  }
  if (!response.ok)
    throw Object.assign(
      new Error(
        [data?.message, data?.error].find(
          (value) => typeof value === "string" && value.trim(),
        ) || `操作失败（HTTP ${response.status}），请稍后重试。`,
      ),
      { status: response.status },
    );
  const hasText = (value) =>
    typeof value === "string" && value.trim().length > 0;
  const hasLoginResult = hasText(data?.token) || hasText(data?.url);
  const pendingRegistration = data?.token === null && hasText(data?.user?.id);
  const expectsStatus = [
    "request-password-reset",
    "reset-password",
    "send-verification-email",
  ].includes(path);
  const redirectField =
    path === "sign-in/social"
      ? "url"
      : path === "oauth2/continue"
        ? "redirect_uri"
        : null;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    (expectsStatus && data.status !== true) ||
    (redirectField && !hasText(data[redirectField])) ||
    (path === "sign-in/email" && !hasLoginResult) ||
    (path === "sign-up/email" && !hasLoginResult && !pendingRegistration)
  )
    throw Object.assign(
      new Error("未能确认操作结果，请先核对邮件或登录状态，避免重复提交。"),
      { status: response.status },
    );
  return data;
}
async function execute(action) {
  if (busy) return;
  manualStarted = true;
  busy = true;
  const buttons = [...document.querySelectorAll("button")];
  buttons.forEach((b) => (b.disabled = true));
  try {
    const email = form.elements.namedItem("email")?.value;
    if (action === "forgot") {
      await send("request-password-reset", {
        email,
        redirectTo: location.origin + "/reset-password",
      });
      notice("如果该邮箱已注册，我们会发送重置邮件。请检查收件箱。");
      return;
    }
    if (action === "reset") {
      const token = new URLSearchParams(location.search).get("token");
      if (!token) throw new Error("重置链接不完整或已失效，请重新申请。");
      await send("reset-password", {
        token,
        newPassword: form.elements.namedItem("password").value,
      });
      history.replaceState({}, "", location.pathname);
      notice("密码已更新，原有登录已退出。请重新登录。");
      return;
    }
    if (action === "resend") {
      await send("send-verification-email", {
        email,
        callbackURL: signedQuery()
          ? location.href
          : location.origin + "/login?verified=1",
      });
      notice("如果该账号需要验证，我们会发送邮件。");
      return;
    }
    if (action.startsWith("provider:")) {
      const provider = action.slice(9);
      const query = signedQuery();
      const result = await send("sign-in/social", {
        providerId: provider,
        provider,
        callbackURL: query ? location.href : location.origin + localReturn(),
        ...(query ? { oauth_query: query } : {}),
      });
      location.assign(result.url);
      return;
    }
    if (options.shared) {
      const result = await send("sign-in/social", {
        provider: "network",
        callbackURL: location.origin + localReturn(),
      });
      location.assign(result.url);
      return;
    }
    const oauth = new URLSearchParams(location.search);
    oauth.delete("returnTo");
    oauth.delete("verified");
    oauth.delete("error");
    const body = {
      email,
      password: form.elements.namedItem("password").value,
      ...(action === "register"
        ? {
            name: form.elements.namedItem("name")?.value || email.split("@")[0],
            callbackURL: signedQuery()
              ? location.href
              : location.origin + "/login?verified=1",
          }
        : {}),
      ...(oauth.has("sig")
        ? { oauth_query: oauth.toString() }
        : location.search.includes("client_id=")
          ? { oauth_query: oauth.toString() }
          : {}),
    };
    // Preserve the signed authorization query exactly as issued by the account center.
    if (
      location.search &&
      !new URLSearchParams(location.search).has("returnTo") &&
      !new URLSearchParams(location.search).has("verified") &&
      !new URLSearchParams(location.search).has("error")
    )
      body.oauth_query = location.search.slice(1);
    const result = await send(
      action === "register" ? "sign-up/email" : "sign-in/email",
      body,
    );
    if (action === "register" && options.requireEmail && !result.token) {
      notice("注册请求已收到，请验证邮箱后回到此页登录。");
      return;
    }
    location.assign(result.url || localReturn());
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false;
    buttons.forEach((b) => (b.disabled = false));
  }
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void execute(
    options.mode === "forgot"
      ? "forgot"
      : options.mode === "reset"
        ? "reset"
        : "login",
  );
});
document
  .querySelector("#register")
  ?.addEventListener("click", () => void execute("register"));
document
  .querySelector("#resend")
  ?.addEventListener("click", () => void execute("resend"));
for (const button of document.querySelectorAll("[data-provider]"))
  button.addEventListener(
    "click",
    () => void execute("provider:" + button.dataset.provider),
  );
const error = new URLSearchParams(location.search).get("error");
if (error) notice("登录或验证链接不可用，请重新发起操作。", true);
if (new URLSearchParams(location.search).has("verified"))
  notice("邮箱已验证，请登录继续。");

if (signedQuery() && !options.shared)
  void (async () => {
    try {
      const response = await fetch("/api/session");
      if (!response.ok || manualStarted) return;
      const user = await response.json();
      if (user && !manualStarted) {
        const result = await send("oauth2/continue", {
          oauth_query: signedQuery(),
        });
        if (!manualStarted && result.redirect_uri)
          location.assign(result.redirect_uri);
      }
    } catch (error) {
      if (!manualStarted) notice(error.message, true);
    }
  })();
