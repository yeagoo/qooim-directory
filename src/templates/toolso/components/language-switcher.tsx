// Ported from toolso-ai-open src/components/language-switcher.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: no client state — the button is a [data-toggle] trigger for a `hidden` menu (src/ui/toolso.js opens/closes it, incl. Escape and outside click); items are links to the page's own alternates instead of router.push; not rendered when the page has fewer than two language versions; inverse treatment dropped; localeNames limited to zh/en.
import { ChevronDown, Globe, Check } from "lucide-react";
import { useLocale, useTranslations } from "../shims/next-intl.js";
import { context } from "../runtime.js";
import { cn } from "../lib/utils.js";

const localeNames: Record<string, string> = {
  en: "English",
  zh: "简体中文",
};

export function LanguageSwitcher({ id = "language-menu", className }: { id?: string; className?: string }) {
  const locale = useLocale();
  const t = useTranslations("qooim.home.a11y");
  const { page } = context();
  // 只在本站语言内切换,并跳到当前页面对应的语言版本
  const alternates = page.alternates.filter((a) => localeNames[a.locale]);
  if (alternates.length < 2) return null;

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        data-toggle={id}
        aria-controls={id}
        className={cn(
          "group flex items-center gap-2 px-3 py-1.5 text-sm rounded-full transition-all duration-200",
          "border border-border bg-popover text-popover-foreground hover:bg-hover focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
        )}
        aria-expanded="false"
        aria-haspopup="true"
        aria-label={t("selectLanguage", { name: localeNames[locale] })}
      >
        <Globe className="w-4 h-4" />
        <span className="font-medium">{localeNames[locale]}</span>
        <ChevronDown className="w-3 h-3 transition-transform duration-200 group-aria-expanded:rotate-180" />
      </button>

      {/* Dropdown Menu */}
      <div
        id={id}
        hidden
        className={cn(
          "absolute right-0 mt-2 py-1 min-w-[150px]",
          "bg-popover text-popover-foreground",
          "border border-border",
          "rounded-lg shadow-lg",
          "animate-in fade-in-0 zoom-in-95",
          "z-50"
        )}
        role="menu"
        aria-orientation="vertical"
      >
        {alternates.map((alt) => {
          const isActive = alt.locale === locale;
          return (
            <a
              key={alt.locale}
              href={alt.url}
              hrefLang={alt.locale}
              lang={alt.locale}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center justify-between w-full px-3 py-2 text-sm",
                "hover:bg-hover",
                "transition-colors duration-150",
                isActive && "bg-accent text-accent-foreground"
              )}
              role="menuitem"
            >
              <span className={cn(
                "font-medium",
                isActive ? "text-accent-foreground" : "text-muted-foreground"
              )}>
                {localeNames[alt.locale]}
              </span>
              {isActive && (
                <Check className="w-4 h-4 text-primary" />
              )}
            </a>
          );
        })}
      </div>
    </div>
  );
}
