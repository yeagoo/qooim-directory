// Ported from toolso-ai-open src/features/tools/components/detail/hero.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: takes a PublicResource; the logo comes from the site media library (initial-letter avatar without one); chips show pricing, the domain, the publish date and, for repositories, GitHub stars/language/archived; tags link to the site's tag pages, and a repository's GitHub topics show as before; the cover is the resource image; all cordis plugin blocks (install, security, trust, history) and the highlights table dropped (no data).
import { Archive, Calendar, Code, Globe, Star } from "lucide-react";
import type { PublicResource } from "../../../../public/sdk.js";
import Image from "../../shims/next-image.js";
import Link from "../../shims/next-link.js";
import { useLocale, useTranslations } from "../../shims/next-intl.js";
import { localePath } from "../../runtime.js";
import { pricingBadge, pricingLabel } from "../catalog/pricing.js";
import { compactNumber, domainOf, externalUrl, formatDate } from "../catalog/resource.js";
import { CoverLightbox } from "./cover-lightbox.js";
import { META_CHIP } from "./shared.js";

/**
 * 详情页英雄区(左列上半):标题与简介、元信息胶囊、标签、封面图。
 * 返回 Fragment —— 这些块是左列 `space-y-7` 的直接子元素,间距由父容器给。
 */
export function DetailHero({ tool }: { tool: PublicResource }) {
  const td = useTranslations("tools.detail");
  const tq = useTranslations("qooim.catalog.github");
  const locale = useLocale();
  const domain = domainOf(tool.url);
  const websiteUrl = externalUrl(tool.url);
  const project = tool.project ?? null;
  const t = useTranslations();
  const pricing = pricingBadge(tool.details?.pricing);
  const published = formatDate(tool.published_at, locale);
  const tags = tool.tags ?? [];
  return (
    <>
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:gap-7">
        {tool.logo ? (
          <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-[1.25rem] bg-white shadow-lift ring-1 ring-foreground/10 md:h-24 md:w-24 md:rounded-3xl">
            <Image
              src={tool.logo.url}
              alt={tool.logo.alt || tool.title}
              fill
              priority
              className="object-cover"
            />
          </div>
        ) : (
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-[1.25rem] bg-secondary ring-1 ring-foreground/5 md:h-24 md:w-24 md:rounded-3xl">
            <span className="text-4xl font-semibold text-muted-foreground">
              {tool.title.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-[2.5rem] font-semibold leading-[1.02] tracking-[-0.04em] text-foreground [overflow-wrap:anywhere] md:text-[3.5rem]">
            {tool.title}
          </h1>
          {tool.description && (
            <p className="mt-4 max-w-[58ch] text-lg leading-relaxed text-muted-foreground md:text-xl md:leading-relaxed">
              {tool.description}
            </p>
          )}
        </div>
      </div>

      {/* Chips */}
      {(pricing || domain || published || project) && (
        <div className="flex flex-wrap items-center gap-2">
          {pricing && (
            <span className={`${META_CHIP} eyebrow !text-[0.625rem] text-foreground`}>
              <span className={`h-1.5 w-1.5 rounded-full bg-gradient-to-br ${pricing.gradient}`} />
              {pricingLabel(pricing, t)}
            </span>
          )}
          {domain && websiteUrl && (
            <a
              href={websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`${META_CHIP} text-[0.8125rem] text-foreground transition-colors hover:border-foreground/40`}
            >
              <Globe className="h-3 w-3 text-muted-foreground" />
              {domain}
            </a>
          )}
          {published && tool.published_at && (
            <span className={`${META_CHIP} text-[0.8125rem] tabular-nums text-muted-foreground`}>
              <Calendar className="h-3 w-3" aria-hidden />
              <span className="sr-only">{td("published")}</span>
              <time dateTime={tool.published_at}>{published}</time>
            </span>
          )}
          {project && (
            <span className={`${META_CHIP} text-[0.8125rem] tabular-nums text-foreground`}>
              <Star className="h-3 w-3 text-muted-foreground" aria-hidden />
              <span className="sr-only">{tq("stars")}</span>
              {compactNumber(project.stars, locale)}
            </span>
          )}
          {project?.language && (
            <span className={`${META_CHIP} text-[0.8125rem] text-muted-foreground`}>
              <Code className="h-3 w-3" aria-hidden />
              {project.language}
            </span>
          )}
          {project?.archived && (
            <span className={`${META_CHIP} text-[0.8125rem] text-muted-foreground`}>
              <Archive className="h-3 w-3" aria-hidden />
              {tq("archived")}
            </span>
          )}
        </div>
      )}

      {/* Tags: the site's own tags link to their pages */}
      {tags.length > 0 && (
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
      )}

      {/* GitHub topics */}
      {project && project.topics.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {project.topics.map((topic) => (
            <span
              key={topic}
              className="num rounded-md bg-secondary px-2 py-1 text-xs text-muted-foreground"
            >
              #{topic}
            </span>
          ))}
        </div>
      )}

      {tool.image && (
        <CoverLightbox
          src={tool.image.url}
          alt={tool.image.alt || td("lightboxAlt", { name: tool.title })}
          websiteUrl={websiteUrl}
          domain={domain}
          closeLabel={td("lightboxClose")}
        />
      )}
    </>
  );
}
