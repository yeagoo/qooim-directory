// Ported from toolso-ai-open src/features/navigation/components/navbar-shell.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: synchronous; categories come from the page data instead of getCategoriesWithCount() (pages without categories get none); per-site route filtering (ownToolsOnly, cordis, ownRoutes) dropped; the site's configured navigation links follow toolso's entries.
import { marketingNavigationKeys } from "./config.js";
import { NavBar, type NavKey } from "./navbar.js";
import { context } from "../../runtime.js";

const TOP_N = 18;

export function NavBarShell() {
  const { page } = context();
  const categories = page.kind === "missing" ? [] : (page.categories ?? []);
  const extra: NavKey[] = page.site.navigation.map((n) => ({ key: `site-${n.href}`, href: n.href, label: n.label }));
  const navItems: NavKey[] = [...marketingNavigationKeys, ...extra];

  const items = categories
    // 按工具数倒排，count 0 的放后面（dropdown 高密度展示 popular 优先）
    .slice()
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .slice(0, TOP_N)
    .map((c) => ({
      id: c.id,
      slug: c.id,
      name: c.label,
      icon: null,
      count: c.count ?? 0,
    }));

  return <NavBar categories={items} navItems={navItems} />;
}
