// Ported from toolso-ai-open src/features/navigation/config.ts (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: only the entries Qoo.IM has pages for (tools; submit, which runtime.localePath sends to /me); hot/blog/pricing/contact, appNavigationKeys and the legacy title-based exports dropped.
// Navigation configuration

export interface NavigationItem {
  key?: string;
  title?: string;
  href: string;
}

// These are the navigation keys for translation
export const marketingNavigationKeys = [
  {
    key: "tools",
    href: "/tools",
  },
  {
    // 工具提交入口(Qoo.IM 的 /me 页对未登录者会提示登录,故全站可见)。
    key: "submit",
    href: "/submit",
  },
];
