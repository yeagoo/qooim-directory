// Ported from toolso-ai-open src/components/featured-tools.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: takes Qoo.IM PublicResource items; hrefs via LocaleLink/localePath instead of siteLocaleHref; cards are the shared catalog ToolCard (logo, tagline, pricing, GitHub stars; no upperstory note/compare button); the section link target is a prop (`href`, the catalog by default) so a curated collection can reuse the block; CategoryIcon via catalog/category-icon; Spotlight is the [data-spotlight] hook.
import type { PublicResource } from "../../../public/sdk.js";
import { ArrowRight } from "lucide-react";
import { SectionHeader, sectionLinkClass } from "./section-header.js";
import { Spotlight } from "./spotlight.js";
import { LocaleLink } from "./locale-link.js";
import { CategoryIcon } from "./navigation/category-mark.js";
import { ToolCard } from "./catalog/tool-card.js";

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
  /** Section link target (toolso-style path); the catalog unless a collection reuses the block. */
  href?: string;
  labels: {
    featuredTitle: string;
    featuredSubtitle: string;
    visitWebsite: string;
    noTools: string;
    viewAllTools: string;
  };
}

export function FeaturedTools({ tools, categories, index, showCategories = true, href = "/tools", labels }: FeaturedToolsProps) {
  return (
    <div className="relative z-20">
      <SectionHeader
        index={index}
        title={labels.featuredTitle}
        description={labels.featuredSubtitle}
        action={
          tools.length > 0 ? (
            <LocaleLink href={href} className={sectionLinkClass}>
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
