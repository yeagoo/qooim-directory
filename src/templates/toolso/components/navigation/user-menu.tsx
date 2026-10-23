// Ported from toolso-ai-open src/features/navigation/components/user-menu.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: the session is unknown at render time, so both states are rendered inside [data-session] — signed-out visible, signed-in `hidden` — and src/ui/toolso.js swaps them, fills [data-email] and handles [data-sign-out]; the menu is a [data-toggle] popup; avatar shows a User icon (no name/image data); dashboard + profile collapse into one Qoo.IM /me link; admin link (admin-status API), loading skeleton and inverse treatment dropped.
import { LayoutDashboard, LogOut, User } from "lucide-react";
import { LocaleLink } from "../locale-link.js";
import { useTranslations } from "../../shims/next-intl.js";

export function UserMenu({ id = "user-menu" }: { id?: string }) {
  const t = useTranslations();

  return (
    <div data-session="" className="flex shrink-0 items-center">
      <div data-when="signed-out">
        <div className="flex shrink-0 items-center gap-2">
          <LocaleLink
            href="/login"
            className="whitespace-nowrap text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("common.actions.signIn")}
          </LocaleLink>
          <LocaleLink
            href="/signup"
            className="whitespace-nowrap rounded-full bg-primary px-4 py-1.5 text-sm text-primary-foreground transition-opacity hover:opacity-90"
          >
            {t("common.actions.signUp")}
          </LocaleLink>
        </div>
      </div>

      <div data-when="signed-in" hidden>
        <div className="relative">
          <button
            type="button"
            data-toggle={id}
            aria-controls={id}
            aria-expanded="false"
            aria-haspopup="menu"
            aria-label={t("qooim.home.a11y.accountMenu")}
            className="h-6 w-6 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xs ring-1 ring-transparent hover:ring-blue-500/50 transition-all"
          >
            <User className="h-3.5 w-3.5" aria-hidden />
          </button>

          <div
            id={id}
            hidden
            role="menu"
            className="absolute right-0 mt-2 min-w-[12rem] max-w-[18rem] bg-popover rounded-lg shadow-navbar border border-border py-1 z-20"
          >
            <div className="px-4 py-2 border-b border-border">
              <p data-email="" className="text-sm font-medium text-foreground break-words" />
            </div>

            <LocaleLink
              href="/dashboard"
              role="menuitem"
              className="flex items-center gap-3 px-4 py-2 text-sm text-muted-foreground hover:bg-hover transition-colors"
            >
              <LayoutDashboard className="w-4 h-4" />
              {t("qooim.home.account")}
            </LocaleLink>

            <div className="border-t border-border mt-1 pt-1">
              <button
                type="button"
                data-sign-out=""
                role="menuitem"
                className="flex items-center gap-3 w-full px-4 py-2 text-sm text-muted-foreground hover:bg-hover transition-colors text-left"
              >
                <LogOut className="w-4 h-4" />
                {t("common.actions.signOut")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
