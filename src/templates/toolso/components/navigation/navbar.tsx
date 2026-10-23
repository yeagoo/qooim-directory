// Ported from toolso-ai-open src/features/navigation/components/navbar.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: marked [data-navbar] as the named group "nav" — src/ui/toolso.js sets data-scrolled on it in place of useScrolledPast(); navigation-appearance.ts (cordis marketplace / trainer routes) and use-marketplace-hero-visible.ts dropped; NavKey may carry a label.
import { DesktopNavbar } from "./desktop-navbar.js";
import { MobileNavbar } from "./mobile-navbar.js";
import type { CategoryMenuItem } from "./categories-menu.js";
import { useTranslations } from "../../shims/next-intl.js";

/** label: site-configured links bring their own text; toolso entries are translated by key. */
export interface NavKey { key: string; href: string; label?: string }

interface NavBarProps {
  categories: CategoryMenuItem[];
  navItems: NavKey[];
}

export function NavBar({ categories, navItems }: NavBarProps) {
  const tA11y = useTranslations("navigation.a11y");

  return (
    <nav
      data-navbar=""
      aria-label={tA11y("primary")}
      className="group/nav fixed top-4 z-50 w-[95%] lg:w-full max-w-7xl mx-auto inset-x-0 animate-fade-in"
    >
      <div className="hidden xl:block w-full">
        <DesktopNavbar
          categories={categories}
          navItems={navItems}
        />
      </div>
      <div className="flex h-full w-full items-center xl:hidden ">
        <MobileNavbar
          categories={categories}
          navItems={navItems}
        />
      </div>
    </nav>
  );
}
