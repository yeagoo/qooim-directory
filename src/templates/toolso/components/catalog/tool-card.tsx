// Ported from toolso-ai-open src/features/tools/components/tool-card.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: takes a PublicResource; links via localePath; logo is always the initial-letter avatar (Qoo.IM has no logos); pricing badge replaced by GitHub stars/language when a project exists; CompareButton (upperstory) dropped.
import { ArrowUpRight, Star } from "lucide-react";
import type { PublicResource } from "../../../../public/sdk.js";
import Link from "../../shims/next-link.js";
import { useLocale, useTranslations } from "../../shims/next-intl.js";
import { localePath } from "../../runtime.js";
import { plainText } from "./plain-text.js";
import { compactNumber, domainOf } from "./resource.js";

interface Props {
  tool: PublicResource;
  visitLabel?: string;
  /** 标题语义层级:列表页卡片是 h2,嵌在版块里(首页精选)用 h3 */
  headingAs?: "h2" | "h3";
  /** 右上角序号(目录索引母题);悬停时让位给箭头 */
  index?: number;
  /** 卡片底部的编辑按语(如 upperstory 的 creator pick) */
  note?: string;
  className?: string;
}

export function ToolCard({ tool, visitLabel, headingAs: Heading = "h2", index, note, className }: Props) {
  const locale = useLocale();
  const tq = useTranslations("qooim.catalog.github");
  const domain = domainOf(tool.url);
  const project = tool.project ?? null;
  const showFooter = Boolean(project || (visitLabel && tool.url));
  return (
    <div className={`flex h-full flex-col gap-2 ${className ?? ""}`}>
    <Link
      href={localePath(`/tools/${tool.slug}`)}
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
          {plainText(tool.description)}
        </p>
      )}

      {note && (
        <p className="mt-4 border-l-2 border-primary/50 pl-3 text-sm leading-relaxed text-foreground">{note}</p>
      )}

      {showFooter && (
        <div className="mt-5 flex items-center justify-between gap-3 border-t border-border/70 pt-3.5">
          {project ? (
            <span className="eyebrow inline-flex items-center gap-2 !text-[0.625rem] text-foreground/80">
              <Star aria-hidden className="h-3 w-3" />
              <span className="sr-only">{tq("stars")}</span>
              <span className="num">{compactNumber(project.stars, locale)}</span>
              {project.language && <span className="normal-case">· {project.language}</span>}
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
    </Link>
    </div>
  );
}
