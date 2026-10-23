// Ported from toolso-ai-open src/features/navigation/components/desktop-navbar.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: the scrolled background is a group-data-[scrolled]/nav variant (src/ui/toolso.js sets data-scrolled on [data-navbar]) instead of the showBackground prop; nav items may carry their own label (site-configured links); nexablocks labels and the inverse (marketplace) appearance dropped; switcher/menu ids passed for the [data-toggle] contract.
import { useTranslations } from "../../shims/next-intl.js";

import { Logo } from "../logo.js";
import { cn } from "../../lib/utils.js";
import { ModeToggle } from "../mode-toggle.js";
import { LanguageSwitcher } from "../language-switcher.js";
import { NavBarItem } from "./navbar-item.js";
import { UserMenu } from "./user-menu.js";
import { CategoriesMenu, type CategoryMenuItem } from "./categories-menu.js";
import type { NavKey } from "./navbar.js";

interface DesktopNavbarProps {
  categories: CategoryMenuItem[];
  navItems: NavKey[];
}

export const DesktopNavbar = ({
  categories,
  navItems,
}: DesktopNavbarProps) => {
  const t = useTranslations('navigation.main');
  const tCat = useTranslations('navigation.categoriesMenu');

  return (
    <div
      className={cn(
        "relative flex w-full justify-between rounded-[1.25rem] border px-4 py-2 transition-[background-color,border-color,box-shadow] duration-200",
        "border-transparent bg-transparent",
        "group-data-[scrolled]/nav:border-border/70 group-data-[scrolled]/nav:bg-background/90 group-data-[scrolled]/nav:shadow-[0_10px_28px_hsl(var(--foreground)/0.08)] group-data-[scrolled]/nav:backdrop-blur-xl",
      )}
    >
      <div className="flex flex-row gap-2 items-center">
        <Logo />
        <div className="flex items-center gap-1.5">
          {navItems.map((item, idx) => (
            <span key={item.key} className="flex items-center gap-1.5">
              <NavBarItem href={item.href}>{item.label ?? t(item.key)}</NavBarItem>
              {/* 第一个 nav 项 (tools) 后面紧跟 Categories 下拉 */}
              {idx === 0 && categories.length > 0 ? (
                <CategoriesMenu
                  items={categories}
                  triggerLabel={tCat("trigger")}
                  viewAllLabel={tCat("viewAll")}
                  id="categories-menu"
                />
              ) : null}
            </span>
          ))}
        </div>
      </div>
      <div className="flex space-x-2 items-center">
        <LanguageSwitcher id="language-menu" />
        <ModeToggle />
        <UserMenu id="user-menu" />
      </div>
    </div>
  );
};
