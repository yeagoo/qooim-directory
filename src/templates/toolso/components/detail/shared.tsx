// Ported from toolso-ai-open src/features/tools/components/detail/shared.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: only META_CHIP and DetailHeading kept; the Markdown renderer, PROSE and the query-derived types dropped (Qoo.IM has no long-form content).
import type { ReactNode } from "react";

/** 头部元信息胶囊(定价 / 域名 / 日期)的共同外形。 */
export const META_CHIP = "inline-flex h-8 items-center gap-2 rounded-full border border-border bg-card px-3";

/** 章节标题:顶部发丝线 + 等宽序号(与右侧目录同号)+ 左对齐标题,右侧可放操作链接。 */
export function DetailHeading({
  index,
  children,
  action,
}: {
  index?: number;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-7 flex items-end justify-between gap-4 border-t border-border pt-5">
      <h2 className="flex items-baseline gap-4 text-[1.625rem] font-semibold leading-tight tracking-[-0.03em] text-foreground md:text-[2rem]">
        {index ? (
          <span className="num shrink-0 text-xs font-normal tracking-normal text-primary">
            {String(index).padStart(2, "0")}
          </span>
        ) : null}
        <span>{children}</span>
      </h2>
      {action}
    </div>
  );
}
