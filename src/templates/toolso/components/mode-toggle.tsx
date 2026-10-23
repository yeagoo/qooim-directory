// Ported from toolso-ai-open src/components/mode-toggle.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: always rendered (no useIsClient/forcedTheme) as a [data-theme-toggle] button that src/ui/toolso.js wires up; both icons are in the markup and the dark: variant picks one; inverse treatment dropped; sr-only label translated.
import { MoonIcon, Sun } from "lucide-react";
import { useTranslations } from "../shims/next-intl.js";
import { cn } from "../lib/utils.js";

export function ModeToggle({ className }: { className?: string }) {
  const t = useTranslations("qooim.home.a11y");
  return (
    <button
      type="button"
      data-theme-toggle=""
      className={cn(
        "flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg outline-none transition-colors focus-visible:outline-none focus-visible:ring-2",
        "hover:bg-hover focus-visible:ring-ring",
        className,
      )}
    >
      <div className="hidden animate-[theme-icon-in_0.3s_ease-out_both] dark:block">
        <MoonIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      </div>
      <div className="animate-[theme-icon-in_0.3s_ease-out_both] dark:hidden">
        <Sun className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      </div>

      <span className="sr-only">{t("toggleTheme")}</span>
    </button>
  );
}
