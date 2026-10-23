// Ported from toolso-ai-open src/features/tools/components/category-sidebar.tsx + category-sidebar-view.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: one file; categories come from page data instead of queries; open/close is the data-toggle hook of /assets/toolso.js (the drawer carries the `hidden` attribute and moves focus in on open / back to the opener on Escape or its close button) instead of React state, so localStorage persistence and click-outside closing are gone; links via localePath; "all" count shown only when known.
import { MoreHorizontal, PanelLeftOpen, X } from "lucide-react";
import type { PublicCategory } from "../../../../public/sdk.js";
import Link from "../../shims/next-link.js";
import { useTranslations } from "../../shims/next-intl.js";
import { useId } from "../../shims/react-hooks.js";
import { localePath } from "../../runtime.js";
import { cn } from "../../lib/utils.js";
import { CategoryIcon } from "./category-icon.js";

interface Props {
  categories: PublicCategory[];
  /** Total published items, when the page knows it (the unfiltered catalog). */
  totalCount?: number;
  activeCategorySlug?: string | null;
  allHref?: string;
  breakpoint?: "lg" | "xl";
  className?: string;
}

const TOP_N = 14;

export function CategorySidebar({
  categories,
  totalCount,
  activeCategorySlug = null,
  allHref = "/tools",
  breakpoint = "lg",
  className,
}: Props) {
  const t = useTranslations("tools");
  const tc = useTranslations("navigation.categoriesMenu");
  const ts = useTranslations("navigation.sidebar");
  const top = [...categories].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, TOP_N);
  const visibilityClass = breakpoint === "xl" ? "hidden xl:block" : "hidden lg:block";
  if (categories.length === 0) return null;
  return (
    <aside aria-label={ts("browseCategories")} className={cn(visibilityClass, className)}>
      <CategorySidebarView
        items={top}
        totalCount={totalCount}
        totalCategories={categories.length}
        activeCategorySlug={activeCategorySlug}
        allHref={allHref}
        labels={{
          title: tc("trigger"),
          all: t("all"),
          viewAll: tc("viewAll"),
          expand: ts("expand"),
          collapse: ts("collapse"),
          browseCategories: ts("browseCategories"),
        }}
      />
    </aside>
  );
}

function CategorySidebarView({
  items,
  totalCount,
  totalCategories,
  activeCategorySlug,
  allHref,
  labels,
}: {
  items: PublicCategory[];
  totalCount?: number;
  totalCategories: number;
  activeCategorySlug: string | null;
  allHref: string;
  labels: {
    title: string;
    all: string;
    viewAll: string;
    expand: string;
    collapse: string;
    browseCategories: string;
  };
}) {
  const drawerId = `category-drawer-${useId()}`;
  // ============ 浮动 Pill 按钮（永远显示，aside 不占 flex 空间）============
  return (
    <>
      <button
        type="button"
        data-toggle={drawerId}
        aria-controls={drawerId}
        aria-expanded="false"
        aria-label={labels.expand}
        title={labels.expand}
        className={cn(
          // 项目原有 'N' widget 在 bottom-6 left-6，错位到 bottom-24
          "fixed bottom-24 left-6 z-50 flex h-10 items-center gap-2 rounded-full pl-3 pr-4",
          "border border-border bg-background text-sm font-medium text-foreground shadow-lg",
          "hover:bg-hover hover:scale-105 active:scale-95 transition-all duration-150",
        )}
      >
        <PanelLeftOpen className="h-4 w-4 shrink-0" />
        <span className="whitespace-nowrap">{labels.browseCategories}</span>
      </button>

      {/* Drawer overlay：从 viewport 左侧滑出，fixed 定位永远跟随当前视野 */}
      <div id={drawerId} hidden className="fixed inset-y-0 left-0 z-40 pointer-events-none">
        <div
          role="dialog"
          aria-label={labels.title}
          className={cn(
            "pointer-events-auto absolute left-4 top-24 w-60 max-h-[calc(100vh-7rem)] overflow-hidden",
            "rounded-2xl border border-border bg-background/95 p-2 shadow-xl backdrop-blur-md",
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between pb-1 pt-0.5">
            <h3 className="pl-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {labels.title}
            </h3>
            <button
              type="button"
              data-toggle={drawerId}
              aria-controls={drawerId}
              aria-expanded="false"
              aria-label={labels.collapse}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <nav className="max-h-[calc(100vh-10rem)] overflow-y-auto pr-1 [scrollbar-width:thin]">
            <ul className="space-y-0.5">
              <li>
                <Link
                  href={localePath(allHref)}
                  className={cn(
                    "flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm transition-colors",
                    activeCategorySlug === null
                      ? "bg-hover font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-hover/60",
                  )}
                >
                  <span>{labels.all}</span>
                  {totalCount !== undefined && <span className="text-xs opacity-60">{totalCount}</span>}
                </Link>
              </li>

              <li className="my-1.5 mx-2 border-t border-border/40" aria-hidden />

              {items.map((c) => (
                <li key={c.id}>
                  <Link
                    href={localePath(`/category/${c.id}`)}
                    aria-current={activeCategorySlug === c.id ? "page" : undefined}
                    className={cn(
                      "flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm transition-colors",
                      activeCategorySlug === c.id
                        ? "bg-hover font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-hover/60",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <CategoryIcon slug={c.id} size={14} className="shrink-0 opacity-80" />
                      <span className="truncate">{c.label}</span>
                    </span>
                    <span className="ml-2 shrink-0 text-xs opacity-60">{c.count}</span>
                  </Link>
                </li>
              ))}

              {totalCategories > items.length && (
                <li className="mt-1">
                  <Link
                    href={localePath("/tools")}
                    className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-hover/60 hover:text-foreground"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                    <span>
                      {labels.viewAll} ({totalCategories})
                    </span>
                  </Link>
                </li>
              )}
            </ul>
          </nav>
        </div>
      </div>
    </>
  );
}
