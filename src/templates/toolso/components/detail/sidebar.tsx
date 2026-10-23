// Ported from toolso-ai-open src/features/tools/components/detail/sidebar.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: takes page data; the quick-info card shows every category of the entry (falling back to the primary one), the domain, pricing, the publish and update dates and the tags; favorite/share are the static hook buttons; a link to the entry's alternatives page follows the visit actions so it does not depend on a related-items block; cordis plugin panels, the upperstory compare block and the J/K hint dropped; links via localePath, the visit link is a plain external link (target=_blank, rel=noopener noreferrer).
import { ArrowRight, ArrowUpRight } from "lucide-react";
import type { PublicCategory, PublicResource, PublicTerm } from "../../../../public/sdk.js";
import Link from "../../shims/next-link.js";
import { useLocale, useTranslations } from "../../shims/next-intl.js";
import { localePath } from "../../runtime.js";
import { CategoryIcon } from "../catalog/category-icon.js";
import { pricingBadge, pricingLabel } from "../catalog/pricing.js";
import { domainOf, externalUrl, formatDate } from "../catalog/resource.js";
import { FavoriteButton } from "./favorite-button.js";
import { SectionToc, type DetailSection } from "./section-nav.js";
import { ShareButton } from "./share-button.js";

/**
 * 详情页右栏:上半(分类 / 域名)随页面滚走;
 * 下半(访问官网 + 收藏 + 分享、目录)吸顶。
 */
export function DetailSidebar({
  tool,
  category,
  canonical,
  sections,
}: {
  tool: PublicResource;
  category?: PublicCategory;
  canonical: string;
  sections: DetailSection[];
}) {
  const t = useTranslations("tools");
  const td = useTranslations("tools.detail");
  const tq = useTranslations("qooim.catalog.detail");
  const root = useTranslations();
  const locale = useLocale();
  const domain = domainOf(tool.url);
  const websiteUrl = externalUrl(tool.url);
  const categories: PublicTerm[] = tool.categories?.length ? tool.categories : category ? [category] : [];
  const tags = tool.tags ?? [];
  const pricing = pricingBadge(tool.details?.pricing);
  const published = formatDate(tool.published_at, locale);
  const updated = formatDate(tool.updated_at, locale);
  return (
    <aside className="space-y-4">
      {/* 1. Quick Info card：分类 / 域名 / 定价 / 日期 / 标签 — 不跟随滚动 */}
      {(categories.length > 0 || domain || pricing || published || tags.length > 0) && (
        <div className="space-y-5 rounded-2xl border border-border bg-card p-5 text-sm">
          {categories.length > 0 && (
            <div>
              <div className="eyebrow mb-2.5">
                {t("categories")}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {categories.map((c) => (
                  <Link
                    key={c.id}
                    href={localePath(`/category/${c.id}`)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:border-foreground/40 hover:bg-hover"
                  >
                    <CategoryIcon slug={c.id} size={14} />
                    <span>{c.label}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
          {domain && websiteUrl && (
            <div>
              <div className="eyebrow mb-1.5">
                {t("domain")}
              </div>
              <a
                href={websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="link-sweep break-all pb-0.5 font-medium text-foreground"
              >
                {domain}
              </a>
            </div>
          )}
          {pricing && (
            <div>
              <div className="eyebrow mb-1.5">
                {root("navigation.main.pricing")}
              </div>
              <div className="inline-flex items-center gap-2 text-foreground">
                <span className={`h-1.5 w-1.5 rounded-full bg-gradient-to-br ${pricing.gradient}`} />
                {pricingLabel(pricing, root)}
              </div>
            </div>
          )}
          {published && tool.published_at && (
            <div>
              <div className="eyebrow mb-1.5">
                {td("published")}
              </div>
              <time dateTime={tool.published_at} className="tabular-nums text-foreground">{published}</time>
            </div>
          )}
          {updated && tool.updated_at && updated !== published && (
            <div>
              <div className="eyebrow mb-1.5">
                {tq("updated")}
              </div>
              <time dateTime={tool.updated_at} className="tabular-nums text-foreground">{updated}</time>
            </div>
          )}
          {tags.length > 0 && (
            <div>
              <div className="eyebrow mb-2.5">
                {tq("tags")}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <Link
                    key={tag.id}
                    href={localePath(`/tag/${tag.id}`)}
                    className="num rounded-md bg-secondary px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
                  >
                    #{tag.label}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== 下半：Visit Website + TOC 跟随滚动 ===== */}
      <div className="space-y-4 lg:sticky lg:top-28">
      {/* 2. Visit Website CTA + ❤️ + Share */}
      <div className="flex gap-2">
        {websiteUrl && (
          <a
            href={websiteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-primary px-6 font-medium text-primary-foreground shadow-[inset_0_1px_0_0_rgba(255,255,255,0.22),0_8px_20px_-8px_hsl(var(--primary)/0.6)] transition-[transform,box-shadow] duration-300 ease-expo hover:-translate-y-px hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.28),0_14px_28px_-10px_hsl(var(--primary)/0.75)] active:scale-[0.97]"
          >
            {t("visitButton")}
            <ArrowUpRight className="h-4 w-4 transition-transform duration-300 ease-expo group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
          </a>
        )}
        <FavoriteButton resourceId={tool.resource_id} labelAdd={td("favoriteAdd")} />
        <ShareButton
          url={canonical}
          title={tool.title}
          ariaLabel={td("share")}
          labels={{
            copyLink: td("shareCopyLink"),
            copied: td("shareCopied"),
            copyFailed: td("shareCopyFailed"),
          }}
        />
      </div>

      <Link
        href={localePath(`/tools/${tool.slug}/alternatives`)}
        className="group inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        {td("alternatives")}
        <ArrowRight className="h-4 w-4 transition-transform duration-300 ease-expo group-hover:translate-x-0.5" />
      </Link>

      {/* 3. TOC(与章节条共用同一份章节清单) */}
      <SectionToc label={td("contents")} sections={sections} />
      </div>{/* /sticky 下半 */}
    </aside>
  );
}
