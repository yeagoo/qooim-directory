// Ported from toolso-ai-open src/components/page-header.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: imports point at the template shims.
import type { ReactNode } from "react";
import Link from "../../shims/next-link.js";
import { ChevronRight } from "lucide-react";
import { useTranslations } from "../../shims/next-intl.js";
import { cn } from "../../lib/utils.js";

export interface Crumb {
  name: string;
  href?: string;
}

/** 等宽面包屑(末项为当前页,不带链接)。 */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  const t = useTranslations("common");
  return (
    <nav aria-label={t("breadcrumb")} className={cn("eyebrow flex flex-wrap items-center gap-2", className)}>
      {items.map((c, i) => (
        <span key={`${c.name}-${i}`} className="flex items-center gap-2">
          {i > 0 && <ChevronRight aria-hidden className="h-3 w-3" />}
          {c.href ? (
            <Link href={c.href} className="transition-colors hover:text-foreground">
              {c.name}
            </Link>
          ) : (
            <span aria-current="page" className="text-foreground">
              {c.name}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * 目录类内页的统一页头(工具列表 / 分类 / 热榜…):面包屑 → 左对齐展示级标题 → 右下等宽元信息,
 * 底部发丝线收束。取代各页各写一份的「居中图标块 + 写死渐变色」。
 */
export function PageHeader({
  crumbs,
  icon,
  title,
  description,
  meta,
  className,
}: {
  crumbs?: Crumb[];
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-12", className)}>
      {crumbs && crumbs.length > 0 && <Breadcrumbs items={crumbs} className="mb-10" />}
      <div className="flex flex-col gap-6 border-b border-border pb-10 md:flex-row md:items-end md:justify-between md:gap-12">
        <div className="min-w-0">
          {icon && (
            <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-[0_10px_24px_-10px_hsl(var(--primary)/0.7)]">
              {icon}
            </div>
          )}
          <h1 className="type-display text-foreground">{title}</h1>
          {description && (
            <p className="mt-5 max-w-[56ch] text-lg leading-relaxed text-muted-foreground">{description}</p>
          )}
        </div>
        {meta && (
          <div className="eyebrow flex shrink-0 items-center gap-3 md:pb-2">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
            {meta}
          </div>
        )}
      </div>
    </div>
  );
}

/** 内页外层容器:与导航/首页同一栅格(max-w-7xl + 统一边距),顶部给浮动导航让位。 */
export const pageShellClass = "relative mx-auto w-full max-w-7xl px-5 pb-20 pt-28 sm:px-8 md:pt-36";

/** 分类胶囊链接,分类页与分类索引共用。 */
export const chipClass =
  "inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-sm text-foreground transition-colors duration-200 hover:border-foreground/40 hover:bg-hover active:scale-[0.97]";

/** 分页按钮(数字用等宽)。 */
export const pagerNumClass =
  "num flex h-10 min-w-10 items-center justify-center rounded-full px-3 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground active:scale-95";
export const pagerNumActiveClass =
  "num flex h-10 min-w-10 items-center justify-center rounded-full bg-foreground px-3 text-sm text-background";
export const pagerStepClass =
  "inline-flex h-10 items-center gap-1 rounded-full border border-border px-4 text-sm transition-colors hover:border-foreground/40 hover:bg-hover active:scale-95";
export const pagerStepDisabledClass =
  "inline-flex h-10 cursor-not-allowed items-center gap-1 rounded-full border border-border px-4 text-sm text-muted-foreground opacity-40";
