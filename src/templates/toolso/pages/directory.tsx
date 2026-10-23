// Ported from toolso-ai-open src/features/tools/components/tools-list-view.tsx (used by app/[locale]/(marketing)/tools/page.tsx and tools/page/[page]/page.tsx) and app/[locale]/(marketing)/category/[slug]/page.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: synchronous, fed by Qoo.IM page data; one component renders the catalog (with ?q=/?category=/?tag=/?page=N), and another a category's or tag's own page (page.categoryPage / page.tagPage; toolso had no tag pages, they reuse the category layout with a "#" heading and sibling tags); head data (title, canonical, JSON-LD, robots) comes from lib/seo.ts; cordis/upperstory/nexablocks filters, rel=prev/next <link>s and the category description dropped (no data); catalog subtitle is the site tagline.
import type { TemplatePage } from "../../../public/sdk.js";
import { Document } from "../document.js";
import { directorySeo } from "../lib/seo.js";
import { SiteChrome } from "../components/site-chrome.js";
import { ChevronRight, Hash } from "lucide-react";
import Link from "../shims/next-link.js";
import { useTranslations } from "../shims/next-intl.js";
import { localePath } from "../runtime.js";
import { Background } from "../components/background.js";
import { CategoryIcon } from "../components/catalog/category-icon.js";
import { CategorySidebar } from "../components/catalog/category-sidebar.js";
import { PageHeader, chipClass, pageShellClass } from "../components/catalog/page-header.js";
import { Pagination, pageHref } from "../components/catalog/pagination.js";
import { ToolCard } from "../components/catalog/tool-card.js";
import { ToolsList } from "../components/catalog/tools-list.js";

type Page = Extract<TemplatePage, { kind: "directory" }>;
export function DirectoryPage({ page }: { page: Page }) {
  return (
    <Document page={page} seo={directorySeo(page)}>
      <SiteChrome>
        <main>
          {page.categoryPage || page.tagPage ? <TermView page={page} /> : <ToolsListView page={page} />}
        </main>
      </SiteChrome>
    </Document>
  );
}

/** 工具列表页(/tools,?page=N)。 */
function ToolsListView({ page }: { page: Page }) {
  const t = useTranslations("tools");
  const tc = useTranslations("tools.category");
  const td = useTranslations("tools.detail");
  const { total, items, limit } = page.result;
  const current = page.result.page;
  const totalPages = Math.ceil(total / limit);
  const base = localePath("/tools");
  const filtered = Boolean(page.q || page.category || page.tag);
  const title = t("title");
  const translations = {
    searchPlaceholder: t("searchPlaceholder"),
    all: t("all"),
    foundTools: t("foundTools", { count: total }),
    noTools: t("noTools"),
  };

  return (
    <div className="relative">
      <Background />

      <div className={pageShellClass}>
        {/* 左对齐大标题 + 右侧等宽计数(本域品牌色,不再是写死的蓝) */}
        <PageHeader
          crumbs={[
            { name: td("home"), href: localePath("/") },
            { name: `${title}${current > 1 ? ` · ${current}` : ""}` },
          ]}
          title={title}
          description={page.site.tagline || undefined}
          meta={tc("toolsCount", { count: total })}
        />

        <div>
          <CategorySidebar
            categories={page.categories}
            totalCount={filtered ? undefined : total}
            activeCategorySlug={page.category ?? null}
          />
          <div className="min-w-0">
            <ToolsList
              tools={items}
              categories={page.categories}
              currentCategory={page.category}
              currentSearch={page.q}
              currentPage={current}
              totalPages={totalPages}
              currentTag={page.tag}
              pageHref={(n) => pageHref(base, { q: page.q, category: page.category, tag: page.tag }, n)}
              translations={translations}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** 分类页(/category/<id>)与标签页(/tag/<id>)。 */
function TermView({ page }: { page: Page }) {
  const isTag = !page.categoryPage;
  const term = (page.categoryPage ?? page.tagPage)!;
  const kind = isTag ? "tag" : "category";
  const t = useTranslations("tools");
  const tc = useTranslations("tools.category");
  const tt = useTranslations("qooim.catalog.tag");
  const td = useTranslations("tools.detail");
  const { total, items: tools, limit } = page.result;
  const current = page.result.page;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const base = localePath(`/${kind}/${term.id}`);
  const label = isTag ? `#${term.label}` : term.label;
  const icon = (id: string, size: number) =>
    isTag ? <Hash aria-hidden className={size > 16 ? "h-5 w-5" : "h-3.5 w-3.5"} /> : <CategoryIcon slug={id} size={size} />;

  // 其它分类（排除自身），按 toolCount 倒排取前 16
  const siblings = (isTag ? page.tags ?? [] : page.categories)
    .filter((c) => c.id !== term.id && c.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 16);

  return (
    <div className="relative">
      <Background />

      <div className={pageShellClass}>
        <PageHeader
          crumbs={[
            { name: td("home"), href: localePath("/") },
            { name: t("title"), href: localePath("/tools") },
            { name: label },
          ]}
          icon={icon(term.id, 22)}
          title={label}
          meta={tc("toolsCount", { count: page.q ? total : term.count })}
        />

        {/* Sibling categories */}
        {siblings.length > 0 && (
          <div className="mb-10">
            <div className="eyebrow mb-3">{isTag ? tt("browseOther") : tc("browseOther")}</div>
            <div className="flex flex-wrap gap-2">
              {siblings.map((c) => (
                <Link key={c.id} href={localePath(`/${kind}/${c.id}`)} className={chipClass}>
                  {icon(c.id, 14)}
                  <span>{c.label}</span>
                  <span className="num text-xs text-muted-foreground">{c.count}</span>
                </Link>
              ))}
              <Link
                href={localePath("/tools")}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-dashed border-border px-3.5 text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
              >
                {tc("viewAllTools")}
                <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
          </div>
        )}

        {/* Tools grid */}
        {tools.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-16 text-center text-muted-foreground">
            {isTag ? tt("noToolsWithTag") : tc("noToolsInCategory")}
          </div>
        ) : (
          <div data-spotlight className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {tools.map((tool) => (
              <ToolCard key={tool.resource_id} tool={tool} />
            ))}
          </div>
        )}

        {/* Pagination */}
        <Pagination page={current} totalPages={totalPages} href={(n) => pageHref(base, { q: page.q }, n)} />
      </div>
    </div>
  );
}
