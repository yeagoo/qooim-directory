const message = document.querySelector("#message");
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function notice(text) {
  message.textContent = text;
  message.classList.toggle("notice", !!text);
}
let actionVersion = 0,
  confirmation = null;
const beginAction = () => {
  const version = ++actionVersion;
  confirmation = null;
  notice("");
  return () => version === actionVersion;
};
async function api(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // A proxy error page or truncated body must not hide the HTTP status.
  }
  if (!response.ok)
    throw Object.assign(
      new Error(
        response.status === 401
          ? "请先登录，再使用收藏与投稿。"
          : [data?.error, data?.message].find(
              (value) => typeof value === "string" && value.trim(),
            ) || `操作失败（HTTP ${response.status}），请稍后重试。`,
      ),
      { status: response.status },
    );
  if (data === null || typeof data !== "object")
    throw Object.assign(
      new Error(
        !body
          ? "服务响应格式异常，请重试加载。"
          : path === "/api/auth/sign-out"
            ? "未能确认退出结果，请刷新页面核对登录状态。"
            : "未能确认操作结果，请先刷新记录核对，避免重复提交。",
      ),
      { status: response.status },
    );
  return data;
}
const favoriteButtons = [...document.querySelectorAll(".favorite")];
const pendingFavorites = new Set();
const syncFavoriteButtons = () => {
  for (const button of favoriteButtons)
    button.disabled = pendingFavorites.has(button.dataset.id);
};
for (const button of favoriteButtons)
  button.addEventListener("click", async () => {
    const resourceId = button.dataset.id;
    if (pendingFavorites.has(resourceId) || !button.isConnected) return;
    pendingFavorites.add(resourceId);
    syncFavoriteButtons();
    const currentAction = beginAction();
    try {
      await api("/api/me/favorites", {
        resourceId,
        enabled: true,
      });
      if (currentAction()) notice("已加入本站收藏。");
    } catch (error) {
      if (currentAction()) notice(error.message);
    } finally {
      pendingFavorites.delete(resourceId);
      syncFavoriteButtons();
    }
  });
const form = document.querySelector("#submission");
if (form) {
  let page = 1,
    submissionPage = 1,
    loadVersion = 0,
    formVersion = 0,
    submissionBusy = false;
  const pendingRemovals = new Set();
  const syncRemovalButtons = () => {
    for (const button of document.querySelectorAll(".remove"))
      button.disabled = pendingRemovals.has(button.dataset.id);
  };
  const acknowledge = (current, text) => {
    if (!current()) return;
    confirmation = text;
    notice(text());
  };
  const reportRead = (error = null) => {
    notice(
      confirmation
        ? confirmation() +
            (error ? " 列表刷新失败，请重试刷新。" + error.message : "")
        : (error?.message ?? ""),
    );
  };
  form.addEventListener("input", () => {
    formVersion++;
  });
  form.addEventListener("reset", () => {
    formVersion++;
  });
  const load = async (messageVersion = actionVersion) => {
    const version = ++loadVersion,
      currentPage = page,
      currentSubmissionPage = submissionPage;
    const current = () => version === loadVersion;
    document.querySelector("#favorites").textContent = "正在加载…";
    document.querySelector("#submissions").textContent = "正在加载…";
    try {
      const locale = document.querySelector("#personal-locale").value;
      const [favorites, submissions, config] = await Promise.all([
        api("/api/me/favorites?locale=" + locale + "&page=" + currentPage),
        api(
          "/api/me/submissions" +
            (currentSubmissionPage === 1
              ? ""
              : "?page=" + currentSubmissionPage),
        ),
        api("/api/config"),
      ]);
      if (!current()) return;
      const lastFavoritePage = Math.max(
        1,
        Math.ceil(favorites.total / favorites.limit),
      );
      if (!favorites.items.length && currentPage > lastFavoritePage) {
        page = lastFavoritePage;
        return await load(messageVersion);
      }
      if (messageVersion === actionVersion) reportRead();
      document.querySelector("#favorites").innerHTML =
        favorites.items
          .map(
            (item) =>
              `<div class="directory-item"><a href="/${item.locale}/${escape(config.config.catalogPath)}/${escape(item.slug)}">${escape(item.title)}</a><button class="secondary remove" data-id="${escape(item.resource_id)}">取消收藏</button></div>`,
          )
          .join("") || '<p class="muted">当前语言还没有可见收藏。</p>';
      document
        .querySelector("#favorites")
        .insertAdjacentHTML(
          "beforeend",
          `<div class="actions">${currentPage > 1 ? '<button id="prev-favorites" class="secondary">上一页</button>' : ""}${currentPage * favorites.limit < favorites.total ? '<button id="next-favorites" class="secondary">下一页</button>' : ""}</div>`,
        );
      document
        .querySelector("#prev-favorites")
        ?.addEventListener("click", () => {
          if (!current()) return;
          page = currentPage - 1;
          void load();
        });
      document
        .querySelector("#next-favorites")
        ?.addEventListener("click", () => {
          if (!current()) return;
          page = currentPage + 1;
          void load();
        });
      document.querySelector("#submissions").innerHTML =
        submissions
          .map(
            (s) =>
              `<article class="resource"><strong>${escape(s.data.title)}</strong><p>${escape({ pending: "待审核", accepted: "已通过审核", rejected: "未接受" }[s.status])} · ${escape(s.note)}</p></article>`,
          )
          .join("") ||
        (currentSubmissionPage > 1
          ? '<p class="muted">本页暂无投稿，可返回上一页。</p>'
          : '<p class="muted">还没有投稿。</p>');
      document
        .querySelector("#submissions")
        .insertAdjacentHTML(
          "beforeend",
          `<div class="actions">${currentSubmissionPage > 1 ? '<button id="prev-submissions" class="secondary">上一页投稿</button>' : ""}${submissions.length === 100 && currentSubmissionPage < 100000 ? '<button id="next-submissions" class="secondary">下一页投稿</button>' : ""}</div>`,
        );
      document
        .querySelector("#prev-submissions")
        ?.addEventListener("click", () => {
          if (!current()) return;
          submissionPage = currentSubmissionPage - 1;
          void load();
        });
      document
        .querySelector("#next-submissions")
        ?.addEventListener("click", () => {
          if (!current()) return;
          submissionPage = currentSubmissionPage + 1;
          void load();
        });
      for (const b of document.querySelectorAll(".remove")) {
        b.disabled = pendingRemovals.has(b.dataset.id);
        b.addEventListener("click", async () => {
          const resourceId = b.dataset.id;
          if (pendingRemovals.has(resourceId) || !b.isConnected) return;
          pendingRemovals.add(resourceId);
          const currentAction = beginAction();
          const messageVersion = actionVersion;
          syncRemovalButtons();
          try {
            await api("/api/me/favorites", {
              resourceId,
              enabled: false,
            });
            acknowledge(currentAction, () => "已取消收藏。");
            await load(messageVersion);
          } catch (error) {
            if (currentAction()) notice(error.message);
          } finally {
            pendingRemovals.delete(resourceId);
            syncRemovalButtons();
          }
        });
      }
      return true;
    } catch (error) {
      if (!current()) return;
      if (messageVersion === actionVersion) reportRead(error);
      document.querySelector("#submissions").textContent = "暂时无法加载投稿。";
      const favorites = document.querySelector("#favorites");
      if (error.status === 401) {
        favorites.innerHTML = '<a href="/login">前往登录 →</a>';
      } else {
        favorites.textContent = "列表加载失败，请重试。";
        const retry = document.createElement("button");
        retry.id = "retry-personal";
        retry.className = "secondary";
        retry.textContent = "重新加载";
        retry.addEventListener("click", () => {
          if (current()) void load();
        });
        favorites.append(retry);
      }
      return false;
    }
  };
  document.querySelector("#personal-locale").addEventListener("change", () => {
    page = 1;
    formVersion++;
    void load();
  });
  const autofill = form.querySelector("#autofill-metadata");
  let metadataBusy = false;
  autofill?.addEventListener("click", async () => {
    if (metadataBusy) return;
    const url = form.elements.namedItem("url").value.trim();
    if (!url) {
      notice("请先填写网站地址。");
      form.elements.namedItem("url").focus();
      return;
    }
    metadataBusy = true;
    autofill.disabled = true;
    autofill.value = "正在获取…";
    const currentAction = beginAction();
    try {
      const metadata = await api("/api/me/submissions/metadata", { url });
      if (!currentAction()) return;
      const title = form.elements.namedItem("title");
      const description = form.elements.namedItem("description");
      let filled = false;
      if (!title.value.trim() && metadata.title) {
        title.value = metadata.title;
        filled = true;
      }
      if (!description.value.trim() && metadata.description) {
        description.value = metadata.description;
        filled = true;
      }
      notice(
        filled
          ? "已填入空白的名称或说明，提交前请核对。"
          : metadata.title || metadata.description
            ? "名称和说明已有内容，未覆盖。"
            : "未获取到可用的名称或说明，请手动填写。",
      );
    } catch (error) {
      if (currentAction()) notice(error.message);
    } finally {
      metadataBusy = false;
      autofill.disabled = false;
      autofill.value = "自动获取名称和说明";
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submissionBusy) return;
    submissionBusy = true;
    const currentAction = beginAction();
    const messageVersion = actionVersion;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    const submittedVersion = formVersion;
    try {
      await api("/api/me/submissions", {
        locale: document.querySelector("#personal-locale").value,
        title: form.elements.namedItem("title").value,
        url: form.elements.namedItem("url").value,
        description: form.elements.namedItem("description").value,
      });
      const keptEdits = formVersion !== submittedVersion;
      if (!keptEdits) form.reset();
      const acknowledgedVersion = formVersion;
      acknowledge(currentAction, () =>
        keptEdits || formVersion !== acknowledgedVersion
          ? "本次投稿已提交，当前编辑尚未提交。"
          : "投稿已提交，等待本站审核。",
      );
      submissionPage = 1;
      await load(messageVersion);
    } catch (error) {
      if (currentAction()) notice(error.message);
    } finally {
      submissionBusy = false;
      button.disabled = false;
    }
  });
  void load();
}

// Renew only through the library endpoint so the browser receives the refreshed cookie.
void fetch("/api/auth/get-session").catch(() => {});
// Templates with their own account menu ([data-session]) handle sign-out themselves.
const accountLink = document.querySelector("[data-session]")
  ? null
  : document.querySelector("header nav");
if (accountLink)
  void (async () => {
    try {
      const response = await fetch("/api/session");
      if (!response.ok) return;
      const user = await response.json();
      if (!user) return;
      const button = document.createElement("button");
      button.className = "secondary";
      button.textContent = "退出本站";
      let signingOut = false;
      button.addEventListener("click", async () => {
        if (signingOut) return;
        signingOut = true;
        button.disabled = true;
        const currentAction = beginAction();
        try {
          await api("/api/auth/sign-out", {});
          location.assign("/");
        } catch (error) {
          signingOut = false;
          button.disabled = false;
          if (currentAction()) notice(error.message);
        }
      });
      accountLink.append(" ", button);
    } catch {}
  })();
