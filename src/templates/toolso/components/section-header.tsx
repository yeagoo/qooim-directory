// Ported from toolso-ai-open src/components/section-header.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: import paths only.
import type { ReactNode } from "react";
import { cn } from "../lib/utils.js";

/**
 * 版块标题(全站统一):顶部发丝线 + 等宽序号/标签 + 左对齐大标题,右侧可放说明或操作。
 * 目录站的「索引」母题 —— 每个版块像目录里的一个条目,而不是居中的营销标题。
 */
export function SectionHeader({
  index,
  eyebrow,
  title,
  description,
  action,
  as: Tag = "h2",
  className,
}: {
  index?: string;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  as?: "h1" | "h2" | "h3";
  className?: string;
}) {
  return (
    <header className={cn("border-t border-border pt-5", className)}>
      {(index || eyebrow) && (
        <div className="eyebrow flex items-center gap-3">
          {index && <span className="text-primary">{index}</span>}
          {index && eyebrow && <span aria-hidden className="h-px w-6 bg-border" />}
          {eyebrow && <span>{eyebrow}</span>}
        </div>
      )}
      <div className="mt-6 flex flex-col gap-6 md:flex-row md:items-end md:justify-between md:gap-12">
        <div className="max-w-3xl">
          <Tag className="type-title text-foreground">{title}</Tag>
          {description && (
            <p className="mt-4 max-w-[58ch] text-base leading-relaxed text-muted-foreground md:text-lg">
              {description}
            </p>
          )}
        </div>
        {action && <div className="shrink-0 md:pb-1.5">{action}</div>}
      </div>
    </header>
  );
}

/** 版块标题右侧的文字链接(箭头悬停前移)。 */
export const sectionLinkClass =
  "group inline-flex items-center gap-2 text-sm font-medium text-foreground transition-colors hover:text-primary";
