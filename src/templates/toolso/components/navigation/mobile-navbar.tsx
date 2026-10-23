// Ported from toolso-ai-open src/features/navigation/components/mobile-navbar.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: the <dialog> + showModal() is a full-screen panel rendered `hidden` and opened/closed by [data-toggle="mobile-nav"] buttons (src/ui/toolso.js; Escape closes); it sits outside the backdrop-blurred bar so `fixed` stays relative to the viewport; the categories group is a [data-toggle] collapse; the account block renders both session states inside [data-session] (signed-in `hidden`, [data-email], [data-sign-out]) with dashboard + profile collapsed into one /me link; scrolled background via group-data-[scrolled]/nav; nexablocks/cordis labels and the inverse appearance dropped.
import { Menu, X } from "lucide-react";

import { Button } from "../button.js";
import { Logo } from "../logo.js";
import { ModeToggle } from "../mode-toggle.js";
import { LanguageSwitcher } from "../language-switcher.js";
import { LocaleLink } from "../locale-link.js";
import { useTranslations } from "../../shims/next-intl.js";
import { cn } from "../../lib/utils.js";
import type { CategoryMenuItem } from "./categories-menu.js";
import type { NavKey } from "./navbar.js";

interface MobileNavbarProps {
  categories: CategoryMenuItem[];
  navItems: NavKey[];
}

const PANEL = "mobile-nav";
const CATEGORIES = "mobile-nav-categories";

export const MobileNavbar = ({
  categories,
  navItems,
}: MobileNavbarProps) => {
  const t = useTranslations('navigation.main');
  const tCommon = useTranslations('common.actions');
  const tCat = useTranslations('navigation.categoriesMenu');
  const tA11y = useTranslations('navigation.a11y');
  const tHome = useTranslations('qooim.home');

  return (
    <>
      <div
        className={cn(
          "flex w-full items-center justify-between rounded-2xl border px-4 py-2 transition-[background-color,border-color,box-shadow] duration-200",
          "border-border/70 bg-background/90 shadow-[0_8px_24px_hsl(var(--foreground)/0.06)] backdrop-blur-xl",
          "group-data-[scrolled]/nav:bg-background/95 group-data-[scrolled]/nav:shadow-[0_10px_28px_hsl(var(--foreground)/0.08)]",
        )}
      >
        <Logo />
        <button
          type="button"
          data-toggle={PANEL}
          aria-controls={PANEL}
          aria-label={tA11y("openMenu")}
          aria-expanded="false"
          className="flex h-10 w-10 items-center justify-center rounded-xl text-foreground transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
      </div>
      <div
        id={PANEL}
        hidden
        role="dialog"
        aria-modal="true"
        aria-label={tA11y("menu")}
        className="fixed inset-0 z-50 m-0 h-[100dvh] w-screen overflow-y-auto border-0 bg-background p-0 pt-4 text-xl text-muted-foreground"
      >
        <div className="flex min-h-full flex-col">
          <div className="flex items-center justify-between w-full px-5 pb-4 shrink-0 border-b border-border">
            <Logo />
            <div className="flex items-center gap-2">
              <ModeToggle />
              <button
                type="button"
                data-toggle={PANEL}
                aria-controls={PANEL}
                aria-expanded="false"
                aria-label={tA11y("closeMenu")}
                className="p-1.5 rounded-lg hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-6 w-6 text-foreground" />
              </button>
            </div>
          </div>
          <div className="flex flex-col items-start justify-start gap-3 px-6 py-6 w-full min-h-0 overflow-y-auto flex-1">
            {navItems.map((navItem, idx) => (
              <div key={navItem.key} className="w-full">
                <LocaleLink
                  href={navItem.href}
                  className="relative block w-full py-2 hover:opacity-70 transition-opacity"
                >
                  <span className="block text-xl text-foreground font-semibold">
                    {navItem.label ?? t(navItem.key)}
                  </span>
                </LocaleLink>
                {/* tools 后面插入 Categories 折叠组 */}
                {idx === 0 && categories.length > 0 ? (
                  <div className="mt-1">
                    <button
                      type="button"
                      data-toggle={CATEGORIES}
                      aria-controls={CATEGORIES}
                      aria-expanded="false"
                      className="group flex w-full items-center justify-between py-2 text-base text-muted-foreground"
                    >
                      <span>{tCat("trigger")}</span>
                      <span className="text-xs group-aria-expanded:hidden">+</span>
                      <span className="hidden text-xs group-aria-expanded:inline">−</span>
                    </button>
                    <ul id={CATEGORIES} hidden className="ml-3 border-l border-border/60 pl-3 pt-1">
                      {categories.slice(0, 18).map((c) => (
                        <li key={c.id} className="mb-0.5">
                          <LocaleLink
                            href={`/category/${c.slug}`}
                            className="flex items-center justify-between py-1.5 text-sm text-muted-foreground hover:text-foreground"
                          >
                            <span className="flex items-center gap-2">
                              {c.icon ? <span className="opacity-80">{c.icon}</span> : null}
                              <span>{c.name}</span>
                            </span>
                            <span className="text-xs opacity-50">{c.count}</span>
                          </LocaleLink>
                        </li>
                      ))}
                      <li>
                        <LocaleLink
                          href="/category"
                          className="block py-1.5 text-sm text-foreground/80 hover:text-foreground"
                        >
                          {tCat("viewAll")} →
                        </LocaleLink>
                      </li>
                    </ul>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <div className="flex flex-col w-full items-start gap-4 px-6 py-5 shrink-0 border-t border-border bg-secondary">
            <div className="w-full">
              <LanguageSwitcher id="mobile-nav-language" />
            </div>
            <div data-session="" className="w-full">
              <div data-when="signed-in" hidden>
                <div className="flex flex-col gap-2 w-full">
                  <div className="pb-3 mb-2 border-b border-border">
                    <p data-email="" className="text-[15px] font-semibold text-foreground" />
                  </div>
                  <LocaleLink
                    href="/dashboard"
                    className="text-[15px] font-medium text-muted-foreground py-2 hover:text-foreground transition-colors"
                  >
                    {tHome("account")}
                  </LocaleLink>
                  <button
                    type="button"
                    data-sign-out=""
                    className="text-[15px] font-medium text-destructive py-2 text-left hover:opacity-80 transition-opacity"
                  >
                    {tCommon('signOut')}
                  </button>
                </div>
              </div>
              <div data-when="signed-out">
                <div className="flex flex-col gap-2.5 w-full">
                  <Button
                    as={LocaleLink}
                    href="/signup"
                    className="w-full justify-center"
                  >
                    {tCommon('signUp')}
                  </Button>
                  <Button
                    variant="simple"
                    as={LocaleLink}
                    href="/login"
                    className="w-full justify-center"
                  >
                    {tCommon('signIn')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
