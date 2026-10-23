// Qoo.IM-specific strings (namespace "qooim.client") for the browser behaviour in
// src/ui/toolso.js. Markup passes them to the script through data attributes, e.g.
//   <button data-copy={text} data-copied-label={t("qooim.client.copied")} ...>
// toolso.js falls back to the Chinese text when an attribute is missing.
//
// Attribute contract (see src/ui/toolso.js):
//   [data-theme-toggle]        aria-label: themeToggle
//   [data-copy]                data-copied-label: copied, data-failed-label: copyFailed
//   [data-share]               data-copied-label: linkCopied, data-failed-label: copyFailed,
//                              data-shared-label: shared
//   [data-sign-out]            data-failed-label: signOutFailed (only when the server gives no reason)
//   [data-lightbox-close]      aria-label: close
//   [data-toggle]              aria-label: openMenu / closeMenu (static; aria-expanded tracks state)
export default {
  en: {
    themeToggle: "Toggle theme",
    themeLight: "Light",
    themeDark: "Dark",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Copy failed. Please copy it manually.",
    share: "Share",
    shared: "Shared",
    linkCopied: "Link copied",
    openMenu: "Open menu",
    closeMenu: "Close menu",
    close: "Close",
    readingProgress: "Reading progress",
    account: "Account",
    signIn: "Sign in",
    signOut: "Sign out",
    signOutFailed: "Could not confirm the sign-out. Refresh the page to check your session.",
    signedInAs: "Signed in as {email}",
  } as Record<string, unknown>,
  zh: {
    themeToggle: "切换主题",
    themeLight: "浅色",
    themeDark: "深色",
    copy: "复制",
    copied: "已复制",
    copyFailed: "复制失败，请手动复制。",
    share: "分享",
    shared: "已分享",
    linkCopied: "链接已复制",
    openMenu: "打开菜单",
    closeMenu: "关闭菜单",
    close: "关闭",
    readingProgress: "阅读进度",
    account: "账号",
    signIn: "登录",
    signOut: "退出登录",
    signOutFailed: "未能确认退出结果，请刷新页面核对登录状态。",
    signedInAs: "已登录：{email}",
  } as Record<string, unknown>,
};
