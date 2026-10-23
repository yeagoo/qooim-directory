// Ported from toolso-ai-open src/components/featured-tools.tsx and src/features/tools/components/tool-card.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: takes Qoo.IM PublicResource items; hrefs via LocaleLink/localePath instead of siteLocaleHref; the card shows the title initial (no logo data), the host of the resource URL as its domain, GitHub stars where the resource has a project (no pricing data), and no upperstory note/compare button; CategoryIcon via catalog/category-icon; Spotlight is the [data-spotlight] hook.
import type { PublicResource } from "../../../public/sdk.js";
import { ArrowRight, ArrowUpRight, Star } from "lucide-react";
import { SectionHeader, sectionLinkClass } from "./section-header.js";
import { Spotlight } from "./spotlight.js";
import { LocaleLink } from "./locale-link.js";
import { CategoryIcon } from "./navigation/category-mark.js";
import { useLocale } from "../shims/next-intl.js";

interface CategoryData {
  id: string;
  slug: string;
  name: string;
  toolCount: number;
}

interface FeaturedToolsProps {
  tools: PublicResource[];
  categories: CategoryData[];
  /** 版块序号(「01」);由首页按本域版块顺序给出 */
  index?: string;
  /** 首页已有独立分类版块时不再重复分类条 */
  showCategories?: boolean;
  labels: {
    featuredTitle: string;
    featuredSubtitle: string;
    visitWebsite: string;
    noTools: string;
    viewAllTools: string;
  };
}

export function FeaturedTools({ tools, categories, index, showCategories = true, labels }: FeaturedToolsProps) {
  return (
    <div className="relative z-20">
      <SectionHeader
        index={index}
        title={labels.featuredTitle}
        description={labels.featuredSubtitle}
        action={
          tools.length > 0 ? (
            <LocaleLink href="/tools" className={sectionLinkClass}>
              {labels.viewAllTools}
              <ArrowRight className="h-4 w-4 transition-transform duration-300 ease-expo group-hover:translate-x-1" />
            </LocaleLink>
          ) : undefined
        }
      />

      {/* 分类导航(仅当首页没有独立分类版块时) */}
      {showCategories && categories.length > 0 && (
        <div className="mt-10 flex flex-wrap gap-2">
          {categories.slice(0, 6).map((category) => (
            <LocaleLink
              key={category.id}
              href={`/category/${category.slug}`}
              className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-card px-3.5 text-sm font-medium text-foreground transition-colors duration-200 hover:border-foreground/40 hover:bg-hover"
            >
              <CategoryIcon slug={category.slug} size={15} />
              {category.name}
              <span className="num text-xs text-muted-foreground">{category.toolCount}</span>
            </LocaleLink>
          ))}
        </div>
      )}

      {/* 工具网格(数量由调用方按域决定,不在此再截断) */}
      {/* 手机端横向吸附滑动(12 张单列卡会把首页拉到近 8 屏);≥sm 回到网格 */}
      {tools.length > 0 && (
        <Spotlight
          className={`no-scrollbar -mx-5 mt-10 flex snap-x snap-mandatory gap-3 overflow-x-auto px-5 pb-6 pt-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:gap-4 sm:overflow-visible sm:px-0 sm:pb-0 lg:grid-cols-3 ${
            tools.length % 4 === 0 ? "xl:grid-cols-4" : ""
          }`}
        >
          {tools.map((tool, i) => (
            <ToolCard
              key={tool.resource_id}
              tool={tool}
              headingAs="h3"
              index={i + 1}
              className="w-[78%] shrink-0 snap-start sm:w-auto"
              visitLabel={labels.visitWebsite}
            />
          ))}
        </Spotlight>
      )}

      {/* 空状态 */}
      {tools.length === 0 && (
        <div className="mt-10 rounded-2xl border border-dashed border-border py-16 text-center text-muted-foreground">
          {labels.noTools}
        </div>
      )}
    </div>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

// toolso src/features/tools/components/tool-card.tsx, for the home page grid.
function ToolCard({
  tool,
  visitLabel,
  headingAs: Heading = "h2",
  index,
  className,
}: {
  tool: PublicResource;
  visitLabel?: string;
  /** 标题语义层级:列表页卡片是 h2,嵌在版块里(首页精选)用 h3 */
  headingAs?: "h2" | "h3";
  /** 右上角序号(目录索引母题);悬停时让位给箭头 */
  index?: number;
  className?: string;
}) {
  const locale = useLocale();
  const domain = hostOf(tool.url);
  const stars = tool.project ? new Intl.NumberFormat(locale, { notation: "compact" }).format(tool.project.stars) : null;
  const showFooter = Boolean(stars || (visitLabel && tool.url));
  return (
    <div className={`flex h-full flex-col gap-2 ${className ?? ""}`}>
    <LocaleLink
      href={`/tools/${tool.slug}`}
      className="surface-card group flex flex-1 flex-col p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-secondary ring-1 ring-foreground/5">
          <span className="text-lg font-semibold text-muted-foreground">
            {tool.title.charAt(0).toUpperCase()}
          </span>
        </div>
        <span className="relative mt-1 flex h-5 min-w-5 items-center justify-end" aria-hidden>
          {typeof index === "number" && (
            <span className="num text-xs text-muted-foreground/70 transition-all duration-300 ease-expo group-hover:-translate-y-1 group-hover:opacity-0">
              {String(index).padStart(2, "0")}
            </span>
          )}
          <ArrowUpRight
            className={`absolute right-0 h-4 w-4 text-primary transition-all duration-300 ease-expo group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100 ${
              typeof index === "number"
                ? "translate-y-1 opacity-0"
                : "-translate-x-0.5 translate-y-0.5 text-muted-foreground/50 opacity-100 group-hover:text-primary"
            }`}
          />
        </span>
      </div>

      <div className="mt-5 min-w-0">
        <Heading className="truncate text-[1.0625rem] font-semibold leading-snug tracking-tight text-foreground">
          {tool.title}
        </Heading>
        {domain && (
          <p className="num mt-0.5 truncate text-xs text-muted-foreground">{domain}</p>
        )}
      </div>

      {tool.description && (
        <p className="mt-3 line-clamp-2 flex-1 text-sm leading-relaxed text-muted-foreground">
          {tool.description}
        </p>
      )}

      {showFooter && (
        <div className="mt-5 flex items-center justify-between gap-3 border-t border-border/70 pt-3.5">
          {stars ? (
            <span className="eyebrow inline-flex items-center gap-1.5 !text-[0.625rem] text-foreground/80">
              <Star className="h-3 w-3" aria-hidden />
              <span className="num">{stars}</span>
            </span>
          ) : (
            <span />
          )}
          {visitLabel && tool.url && (
            <span className="text-xs text-muted-foreground transition-colors group-hover:text-foreground">
              {visitLabel}
            </span>
          )}
        </div>
      )}
    </LocaleLink>
    </div>
  );
}
