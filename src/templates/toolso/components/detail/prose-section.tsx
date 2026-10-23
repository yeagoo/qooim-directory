// Ported from toolso-ai-open src/features/tools/components/detail/prose-section.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: also renders a plain-text bullet list (`items`, for key features and use cases) inside the same prose article instead of only a Markdown body.
import { DetailHeading, DetailMarkdown, PROSE } from "./shared.js";

/** 一个由 Markdown 正文(或纯文本要点列表)构成的章节(概览、功能、使用场景)。 */
export function DetailProseSection({
  slug,
  title,
  index,
  body,
  items,
}: {
  slug: string;
  title: string;
  index?: number;
  body?: string;
  items?: string[];
}) {
  return (
    <section id={`section-${slug}`} className="detail-section">
      <DetailHeading index={index}>{title}</DetailHeading>
      <article className={PROSE}>
        {body ? <DetailMarkdown>{body}</DetailMarkdown> : null}
        {items && items.length > 0 ? (
          <ul>
            {items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        ) : null}
      </article>
    </section>
  );
}
