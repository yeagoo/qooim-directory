// Ported from toolso-ai-open src/features/tools/components/tool-detail-shell.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: no client state: the reading progress bar is the data-reading-progress hook of /assets/toolso.js (it sets --progress from the [data-reading-target] content), the current section is marked by the data-section-nav hook (see section-nav.tsx); the floating CTA bar, J/K adjacent-tool keys and hidden prev/next links dropped (no scroll-state hook, no adjacency data).
import type { ReactNode } from "react";

/**
 * 包裹整个详情页,负责:
 *  - 阅读进度条
 *  - 入场动画
 */
export function ToolDetailShell({ children }: { children: ReactNode }) {
  return (
    <>
      {/* 阅读进度条 */}
      <div className="fixed top-0 left-0 right-0 h-0.5 z-50 pointer-events-none">
        <div
          data-reading-progress
          className="h-full bg-primary origin-left transition-transform [transform:scaleX(var(--progress,0))]"
        />
      </div>

      <div data-reading-target className="animate-[tool-detail-content-in_0.4s_ease-out_both]">
        {children}
      </div>
    </>
  );
}
