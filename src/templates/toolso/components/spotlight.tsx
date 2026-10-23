// Ported from toolso-ai-open src/components/spotlight.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: markup only; the pointermove handler that writes --mx/--my now lives in src/ui/toolso.js, found through [data-spotlight].
import type { HTMLAttributes } from "react";

/**
 * 卡片聚光的事件委托容器:指针移动时把相对坐标写到命中的 .surface-card 上(--mx/--my),
 * 由 globals.css 的 ::before 径向渐变消费。一个监听器覆盖整组卡片。
 */
export function Spotlight({ children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div data-spotlight="" {...rest}>
      {children}
    </div>
  );
}
