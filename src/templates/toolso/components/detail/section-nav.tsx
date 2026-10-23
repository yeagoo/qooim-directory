// Ported from toolso-ai-open src/features/tools/components/detail-section-nav.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: sections are passed as props instead of React context; the current section is marked by /assets/toolso.js through the data-section-nav hook (aria-current="true"), styled with aria-current variants; plain #hash links (no click interception or tab-strip auto-scroll).

export interface DetailSection {
  slug: string;
  title: string;
}

export const sectionElementId = (slug: string) => `section-${slug}`;

/** 详情页里「英雄区到此为止」的标记。 */
export const DETAIL_HERO_END_ID = "tool-detail-hero-end";

/**
 * 吸顶章节条 —— 只在 < lg 出现。桌面有常驻的右栏目录(SectionToc),再放一条会重复占用阅读区。
 *
 * 落点不在 JS 里算:由 `html { scroll-padding-top }` 与章节的 `.detail-section`(scroll-margin-top)决定,
 * 平滑与否由全局的 scroll-behavior 决定(已尊重 reduced-motion)。
 */
export function SectionTabs({ label, sections }: { label: string; sections: DetailSection[] }) {
  if (sections.length < 2) return null;
  return (
    <nav
      aria-label={label}
      data-section-nav
      className="detail-tabs sticky z-20 -mx-5 border-y border-border bg-background/90 px-5 backdrop-blur-xl sm:-mx-8 sm:px-8 lg:hidden"
    >
      <div className="no-scrollbar flex gap-1 overflow-x-auto py-2">
        {sections.map((section) => (
          <a
            key={section.slug}
            href={`#${sectionElementId(section.slug)}`}
            data-slug={section.slug}
            className="shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors text-muted-foreground hover:bg-secondary hover:text-foreground aria-[current=true]:bg-foreground aria-[current=true]:text-background"
          >
            {section.title}
          </a>
        ))}
      </div>
    </nav>
  );
}

/** 右栏目录(桌面):与章节条同一份章节清单,高亮当前章节。 */
export function SectionToc({ label, sections }: { label: string; sections: DetailSection[] }) {
  if (sections.length === 0) return null;
  return (
    <nav aria-label={label} data-section-nav className="hidden rounded-2xl border border-border bg-card p-5 lg:block">
      <div className="eyebrow mb-2.5">{label}</div>
      <ul className="border-l border-border">
        {sections.map((section, i) => (
          <li key={section.slug}>
            <a
              href={`#${sectionElementId(section.slug)}`}
              className="group -ml-px flex items-baseline gap-3 truncate border-l py-1.5 pl-4 text-sm transition-colors hover:border-primary hover:text-foreground border-transparent text-muted-foreground aria-[current=true]:border-primary aria-[current=true]:font-medium aria-[current=true]:text-foreground"
            >
              <span className="num text-[0.625rem] text-muted-foreground/70 group-aria-[current=true]:text-primary">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="truncate">{section.title}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
