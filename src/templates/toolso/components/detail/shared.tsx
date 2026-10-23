// Ported from toolso-ai-open src/features/tools/components/detail/shared.tsx and src/components/markdown-link.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: the query-derived types and the code-highlight renderers dropped; DetailMarkdown skips raw HTML and drops images (the CSP only allows same-origin images); MarkdownLink sends every absolute http(s) link to a new tab with rel="noopener noreferrer nofollow ugc" (no site-network allowlist) and renders other links as plain anchors.
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** 头部元信息胶囊(定价 / 域名 / 日期)的共同外形。 */
export const META_CHIP = "inline-flex h-8 items-center gap-2 rounded-full border border-border bg-card px-3";

/** 正文排版:颜色变量在 globals.css 按本域色相覆盖;这里只定版心宽度与细节。 */
export const PROSE =
  "prose dark:prose-invert max-w-[70ch] prose-headings:font-semibold prose-headings:tracking-tight prose-p:leading-[1.75] prose-li:leading-[1.7] prose-a:font-medium prose-a:underline-offset-4 prose-img:rounded-xl prose-pre:rounded-xl";

type AnchorProps = ComponentPropsWithoutRef<"a"> & { node?: unknown };

/** Markdown `<a>`: absolute http(s) links open in a new tab and carry no endorsement. */
export function MarkdownLink({ href, children, node: _node, ...rest }: AnchorProps) {
  const url = typeof href === "string" ? href : "";
  if (/^https?:\/\//i.test(url))
    return (
      <a href={url} target="_blank" rel="noopener noreferrer nofollow ugc" {...rest}>
        {children}
      </a>
    );
  // react-markdown's default urlTransform already blanked unsafe schemes (javascript:, data:, ...).
  if (!url) return <span {...rest}>{children}</span>;
  return (
    <a href={url} {...rest}>
      {children}
    </a>
  );
}

/** 详情页正文统一的 Markdown 渲染。Listing Markdown is untrusted: no raw HTML, no images. */
export const MARKDOWN_COMPONENTS = { a: MarkdownLink };

export function DetailMarkdown({ children }: { children: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={MARKDOWN_COMPONENTS}
      skipHtml
      disallowedElements={["img"]}
    >
      {children}
    </Markdown>
  );
}

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
