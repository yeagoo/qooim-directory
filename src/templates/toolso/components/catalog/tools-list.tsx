// Ported from toolso-ai-open src/features/tools/components/tools-list.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: server-rendered without hydration: search is a GET form to the catalog (`q`, keeping a ?category= filter), category chips and pager buttons are links (chips go to category pages, pages use ?page=N), the "+N / Less" chip toggle is the data-toggle hook of /assets/toolso.js; Spotlight is the data-spotlight hook; takes Qoo.IM page data; per-site empty-state illustration dropped.
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import type { PublicCategory, PublicResource } from "../../../../public/sdk.js";
import Link from "../../shims/next-link.js";
import { useTranslations } from "../../shims/next-intl.js";
import { useId } from "../../shims/react-hooks.js";
import { localePath } from "../../runtime.js";
import { CategoryIcon } from "./category-icon.js";
import { ToolCard } from "./tool-card.js";

interface ToolsTranslations {
  searchPlaceholder: string;
  all: string;
  foundTools: string;
  noTools: string;
}

interface ToolsListProps {
  tools: PublicResource[];
  categories: PublicCategory[];
  currentCategory?: string;
  currentSearch?: string;
  currentPage: number;
  totalPages: number;
  /** URL of page N with the current search/filter kept. */
  pageHref: (page: number) => string;
  translations: ToolsTranslations;
}

const chipBase =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors duration-200 active:scale-[0.97]";
const chipIdle = "border-border bg-card text-foreground hover:border-foreground/40 hover:bg-hover";
const chipActive = "border-foreground bg-foreground text-background";

export function ToolsList({
  tools,
  categories,
  currentCategory,
  currentSearch,
  currentPage,
  totalPages,
  pageHref,
  translations,
}: ToolsListProps) {
  // 全语言走 messages(此前 zh/tw vs en 二元硬编码,vi/fr/… 落英文)
  const ts = useTranslations("tools");
  const toolsBase = localePath("/tools");
  const moreId = `more-categories-${useId()}`;

  // 默认只展示前 12 个最热分类；激活的分类（即使排在 12 之后）也必出现
  const TOP_N = 12;
  const sortedCategories = [...categories]
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);
  const topCategories = sortedCategories.slice(0, TOP_N);
  const activeBeyondTop =
    currentCategory && !topCategories.some((c) => c.id === currentCategory)
      ? sortedCategories.find((c) => c.id === currentCategory)
      : null;
  const visibleCategories = activeBeyondTop ? [...topCategories, activeBeyondTop] : topCategories;
  const hiddenCategories = sortedCategories.filter((c) => !visibleCategories.includes(c));

  const searchLabel = translations.searchPlaceholder || "Search tools";
  const previousPageLabel = ts("category.prev");
  const nextPageLabel = ts("category.next");

  const chip = (category: PublicCategory) => {
    const active = currentCategory === category.id;
    return (
      <Link
        key={category.id}
        href={localePath(`/category/${category.id}`)}
        data-testid="category-chip"
        aria-current={active ? "page" : undefined}
        className={`${chipBase} ${active ? chipActive : chipIdle}`}
      >
        <CategoryIcon slug={category.id} size={14} />
        <span>{category.label}</span>
        <span className={`num text-xs ${active ? "text-background/70" : "text-muted-foreground"}`}>
          {category.count}
        </span>
      </Link>
    );
  };

  return (
    <div className="space-y-8">
      {/* 搜索 + 分类筛选:一行工具条(搜索在前,结果数紧随其后) */}
      <div className="flex flex-col gap-6">
        <form method="get" action={toolsBase} role="search" className="flex max-w-2xl gap-2">
          <div className="flex h-12 flex-1 items-center gap-3 rounded-full border border-border bg-card px-5 transition-[border-color,box-shadow] duration-300 focus-within:border-primary focus-within:shadow-[0_0_0_4px_hsl(var(--primary)/0.12)]">
            <Search className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <input
              type="search"
              name="q"
              aria-label={searchLabel}
              placeholder={translations.searchPlaceholder}
              defaultValue={currentSearch || ""}
              maxLength={200}
              className="w-full bg-transparent text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
            />
          </div>
          {currentCategory && <input type="hidden" name="category" value={currentCategory} />}
          <button
            type="submit"
            aria-label={searchLabel}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-transform duration-300 ease-expo hover:-translate-y-px active:scale-95"
          >
            <Search className="h-4 w-4" />
          </button>
        </form>

        <div>
          <div className="eyebrow mb-3 flex items-center justify-between gap-4">
            <span>{ts("browseByCategory")}</span>
            <span className="text-foreground">{translations.foundTools}</span>
          </div>
          {/* 手机端单行横滑(12 个胶囊换行会占掉大半屏);≥sm 换行平铺 */}
          <div className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
            <Link
              href={currentSearch ? `${toolsBase}?${new URLSearchParams({ q: currentSearch })}` : toolsBase}
              data-testid="category-chip"
              aria-current={!currentCategory ? "page" : undefined}
              className={`${chipBase} ${!currentCategory ? chipActive : chipIdle}`}
            >
              <span>{translations.all}</span>
            </Link>
            {visibleCategories.map(chip)}
            {hiddenCategories.length > 0 && (
              <>
                <span id={moreId} hidden className="[&:not([hidden])]:contents">
                  {hiddenCategories.map(chip)}
                </span>
                <button
                  type="button"
                  data-toggle={moreId}
                  aria-controls={moreId}
                  aria-expanded="false"
                  className="group inline-flex h-9 shrink-0 items-center gap-1 rounded-full border border-dashed border-border px-3.5 text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
                >
                  <span className="hidden items-center gap-1 group-aria-expanded:inline-flex">
                    <ChevronLeft className="h-3.5 w-3.5" />
                    {ts("showLess")}
                  </span>
                  <span className="inline-flex items-center gap-1 group-aria-expanded:hidden">
                    <span className="num">+{hiddenCategories.length}</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 工具网格 — 复用 ToolCard，与 /category/<slug> 视觉一致 */}
      {tools.length > 0 && (
        <div data-spotlight className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {tools.map((tool) => (
            <ToolCard key={tool.resource_id} tool={tool} />
          ))}
        </div>
      )}

      {/* 空状态 */}
      {tools.length === 0 && (
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-border py-16 text-center">
          <p className="text-muted-foreground">
            {translations.noTools}
          </p>
        </div>
      )}

      {/* 分页 */}
      {totalPages > 1 && (
        <nav aria-label={ts("category.page", { page: currentPage })} className="flex items-center justify-center gap-2 pt-6">
          <PagerStep href={currentPage > 1 ? pageHref(currentPage - 1) : null} label={previousPageLabel} rel="prev">
            <ChevronLeft className="h-4 w-4" />
          </PagerStep>

          <div className="flex items-center gap-1">
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((page) => {
                if (totalPages <= 7) return true;
                if (page === 1 || page === totalPages) return true;
                if (Math.abs(page - currentPage) <= 1) return true;
                return false;
              })
              .map((page, index, arr) => {
                const prevPage = arr[index - 1];
                const showEllipsis = prevPage && page - prevPage > 1;
                const current = currentPage === page;
                return (
                  <div key={page} className="flex items-center">
                    {showEllipsis && (
                      <span className="px-1.5 text-muted-foreground">…</span>
                    )}
                    <Link
                      href={pageHref(page)}
                      aria-label={ts("category.page", { page })}
                      aria-current={current ? "page" : undefined}
                      className={`num flex h-10 min-w-10 items-center justify-center rounded-full px-3 text-sm transition-colors active:scale-95 ${
                        current
                          ? "bg-foreground text-background"
                          : "text-muted-foreground hover:bg-hover hover:text-foreground"
                      }`}
                    >
                      {page}
                    </Link>
                  </div>
                );
              })}
          </div>

          <PagerStep href={currentPage < totalPages ? pageHref(currentPage + 1) : null} label={nextPageLabel} rel="next">
            <ChevronRight className="h-4 w-4" />
          </PagerStep>
        </nav>
      )}
    </div>
  );
}

const pagerStep =
  "flex h-10 w-10 items-center justify-center rounded-full border border-border transition-colors hover:border-foreground/40 hover:bg-hover active:scale-95";

/** toolso's disabled <button> becomes an inert span when there is no page to go to. */
function PagerStep({ href, label, rel, children }: { href: string | null; label: string; rel: string; children: ReactNode }) {
  return href ? (
    <Link href={href} rel={rel} aria-label={label} className={pagerStep}>
      {children}
    </Link>
  ) : (
    <span aria-hidden className={`${pagerStep} cursor-not-allowed opacity-40`}>
      {children}
    </span>
  );
}
