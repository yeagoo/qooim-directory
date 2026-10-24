/** M16. Shared rendering for the basic and editorial templates: rich detail fields, Markdown, alternatives and comparison pages. */
import type { ReactNode } from "react";
import {
  escapeHtml,
  frameParts,
  pagination,
  projectSummary,
  resourceUrl,
  searchForm,
  type PageMeta,
  type PublicPricing,
  type PublicResource,
  type TemplatePage,
} from "../public/sdk.js";
import { DetailMarkdown } from "./toolso/components/detail/shared.js";

type Directory = Extract<TemplatePage, { kind: "directory" }>;
type Detail = Extract<TemplatePage, { kind: "detail" }>;
export type ClassicLayout = {
  layout: string;
  /** Masthead of the plain directory listing. */
  intro: (page: Directory) => string;
  /** Renders the list of cards; `card` is the shared rich card. */
  list: (page: Directory, items: PublicResource[], card: (item: PublicResource) => string) => string;
  empty: string;
  missing: (page: Extract<TemplatePage, { kind: "missing" }>) => string;
};

const PRICING: Record<"zh" | "en", Record<PublicPricing, string>> = {
  zh: { free: "免费", freemium: "免费增值", paid: "付费", trial: "可试用", "open-source": "开源", contact: "联系销售" },
  en: { free: "Free", freemium: "Freemium", paid: "Paid", trial: "Free trial", "open-source": "Open source", contact: "Contact sales" },
};
const TEXT = {
  zh: {
    all: "← 全部资源", from: "精选自", visit: "访问网站 ↗", favorite: "收藏", overview: "概览", features: "主要功能",
    useCases: "使用场景", pros: "优点", cons: "不足", faq: "常见问题", compare: "对比", comparisons: "对比评测",
    alternatives: "查看替代品", alternativesOf: (t: string) => `${t} 的替代品`, back: (t: string) => `← 返回 ${t}`,
    published: "收录于", categories: "分类", tags: "标签", results: (n: number) => `${n} 个发现`,
  },
  en: {
    all: "← All entries", from: "Picked by", visit: "Visit website ↗", favorite: "Save", overview: "Overview", features: "Key features",
    useCases: "Use cases", pros: "Pros", cons: "Cons", faq: "FAQ", compare: "Compare with", comparisons: "Comparisons",
    alternatives: "See alternatives", alternativesOf: (t: string) => `Alternatives to ${t}`, back: (t: string) => `← Back to ${t}`,
    published: "Listed", categories: "Categories", tags: "Tags", results: (n: number) => `${n} entries`,
  },
};
const text = (page: TemplatePage) => TEXT[page.locale === "en" ? "en" : "zh"];
const pricing = (page: TemplatePage, value?: PublicPricing) =>
  value ? `<span class="pricing-badge">${escapeHtml(PRICING[page.locale === "en" ? "en" : "zh"][value] ?? value)}</span>` : "";
const base = (page: TemplatePage) => `/${page.locale}/${page.catalogPath}`;

/** Escapes <, >, & and the JS line separators so JSON cannot leave its script element. */
const UNSAFE_JSON = new RegExp("[<>&" + String.fromCharCode(0x2028, 0x2029) + "]", "g");
function safeJson(value: unknown) {
  return JSON.stringify(value).replace(UNSAFE_JSON, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
/** A balanced, already escaped HTML fragment. */
function Html({ html }: { html: string }) {
  return html ? <div className="html-slot" dangerouslySetInnerHTML={{ __html: html }} /> : null;
}
function Prose({ children }: { children?: string }) {
  return children ? (
    <div className="prose-block">
      <DetailMarkdown>{children}</DetailMarkdown>
    </div>
  ) : null;
}

export function card(page: TemplatePage, item: PublicResource) {
  const tagline = item.details?.tagline;
  return `<article class="directory-item">${item.image ? `<img class="item-image" src="${escapeHtml(item.image.url)}" alt="${escapeHtml(item.image.alt)}" loading="lazy" decoding="async">` : ""}<div>${item.logo ? `<img class="item-logo" src="${escapeHtml(item.logo.url)}" alt="${escapeHtml(item.logo.alt)}" width="40" height="40" loading="lazy" decoding="async">` : ""}<a class="item-title" href="${escapeHtml(resourceUrl(page, item))}">${escapeHtml(item.title)}</a>${pricing(page, item.details?.pricing)}${tagline ? `<p class="item-tagline">${escapeHtml(tagline)}</p>` : ""}<p class="muted">${escapeHtml(item.description)}</p>${projectSummary(item.project)}</div><button class="secondary favorite" data-id="${escapeHtml(item.resource_id)}">${escapeHtml(text(page).favorite)}</button></article>`;
}
const list = (items: string[] | undefined, title: string, id: string) =>
  items?.length ? `<section class="detail-section" id="section-${id}"><h2>${escapeHtml(title)}</h2><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul></section>` : "";

function detail(page: Detail, supports: Supports) {
  const t = text(page), item = page.item, d = item.details ?? {};
  const terms = (kind: "category" | "tag", terms: { id: string; label: string }[] | undefined, label: string) =>
    terms?.length ? `<p class="detail-terms"><span class="muted">${escapeHtml(label)}</span> ${terms.map((x) => `<a href="${escapeHtml(`${base(page)}/${kind}/${x.id}`)}">${kind === "tag" ? "#" : ""}${escapeHtml(x.label)}</a>`).join(" · ")}</p>` : "";
  const head = `<a href="${escapeHtml(base(page))}">${escapeHtml(t.all)}</a><p class="eyebrow">${escapeHtml(t.from)} ${escapeHtml(page.site.name)}</p>${item.image ? `<img class="detail-image" src="${escapeHtml(item.image.url)}" alt="${escapeHtml(item.image.alt)}" loading="eager" decoding="async">` : ""}${item.logo ? `<img class="detail-logo" src="${escapeHtml(item.logo.url)}" alt="${escapeHtml(item.logo.alt)}" width="64" height="64" decoding="async">` : ""}<h1>${escapeHtml(item.title)}</h1>${d.tagline ? `<p class="detail-tagline">${escapeHtml(d.tagline)}</p>` : ""}<p class="detail-description">${escapeHtml(item.description)}</p><p class="detail-meta">${pricing(page, d.pricing)}${item.published_at ? ` <span class="muted">${escapeHtml(t.published)} <time datetime="${escapeHtml(item.published_at)}">${escapeHtml(item.published_at.slice(0, 10))}</time></span>` : ""}</p>${terms("category", item.categories, t.categories)}${terms("tag", item.tags, t.tags)}${projectSummary(item.project)}${item.project ? `<p class="muted">Forks ${escapeHtml(item.project.forks)} · Issues ${escapeHtml(item.project.openIssues)} · ${item.project.topics.map(escapeHtml).join(" / ")}</p>` : ""}<div class="actions">${item.url ? `<a class="button" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.visit)}</a>` : ""}<button class="secondary favorite" data-id="${escapeHtml(item.resource_id)}">${escapeHtml(t.favorite)}</button>${supports.alternatives ? `<a class="alternatives-link" href="${escapeHtml(`${resourceUrl(page, item)}/alternatives`)}">${escapeHtml(t.alternatives)}</a>` : ""}</div>`;
  const lists = `${list(d.features, t.features, "features")}${list(d.useCases, t.useCases, "use-cases")}${d.pros?.length || d.cons?.length ? `<section class="detail-section pros-cons" id="section-pros-cons">${list(d.pros, t.pros, "pros")}${list(d.cons, t.cons, "cons")}</section>` : ""}`;
  const comparisons = page.comparisons?.length
    ? `<section class="detail-section" id="section-comparisons"><h2>${escapeHtml(t.comparisons)}</h2><ul>${page.comparisons.map((c) => `<li><a href="${escapeHtml(`${base(page)}/compare/${c.id}`)}">${escapeHtml(t.compare)} ${escapeHtml(c.other.title)}</a></li>`).join("")}</ul></section>`
    : "";
  const tail = `${comparisons}<nav>${page.alternates.map((a) => `<a href="${escapeHtml(a.url)}">${a.locale === "zh" ? "中文" : "English"}</a>`).join(" · ")}</nav>`;
  const faqs = d.faqs ?? [];
  return {
    jsonLd: faqs.length
      ? { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: f.answer } })) }
      : null,
    body: (
      <section className="resource-detail">
        <Html html={head} />
        {d.content ? (
          <section className="detail-section" id="section-overview">
            <h2>{t.overview}</h2>
            <Prose>{d.content}</Prose>
          </section>
        ) : null}
        <Html html={lists} />
        {faqs.length ? (
          <section className="detail-section" id="section-faq">
            <h2>{t.faq}</h2>
            {faqs.map((f, i) => (
              <details key={i}>
                <summary>{f.question}</summary>
                <Prose>{f.answer}</Prose>
              </details>
            ))}
          </section>
        ) : null}
        <Html html={tail} />
      </section>
    ),
  };
}

function directory(page: Directory, l: ClassicLayout): { meta: PageMeta; body: ReactNode } {
  const t = text(page), cardOf = (item: PublicResource) => card(page, item);
  const listing = page.result.items.length ? l.list(page, page.result.items, cardOf) : l.empty;
  if (page.comparison) {
    const c = page.comparison;
    return {
      meta: { title: `${c.title} · ${page.site.name}` },
      body: (
        <section className="resource-detail comparison">
          <Html html={`<a href="${escapeHtml(base(page))}">${escapeHtml(t.all)}</a><h1>${escapeHtml(c.title)}</h1>${listing}`} />
          <Prose>{c.content}</Prose>
        </section>
      ),
    };
  }
  if (page.alternativesOf) {
    const of = page.alternativesOf, title = t.alternativesOf(of.title);
    return {
      meta: { title: `${title} · ${page.site.name}` },
      body: <Html html={`<section class="directory-intro"><a href="${escapeHtml(resourceUrl(page, of))}">${escapeHtml(t.back(of.title))}</a><h1>${escapeHtml(title)}</h1></section><section class="directory-list">${listing}</section>`} />,
    };
  }
  const term = page.categoryPage ?? page.tagPage ?? page.collectionPage;
  const intro = term
    ? `<section class="directory-intro"><a href="${escapeHtml(base(page))}">${escapeHtml(t.all)}</a><h1>${page.tagPage ? "#" : ""}${escapeHtml(term.label)}</h1>${page.collectionPage?.description ? `<p class="muted">${escapeHtml(page.collectionPage.description)}</p>` : ""}</section>`
    : l.intro(page) + searchForm(page);
  return {
    meta: term ? { title: `${term.label} · ${page.site.name}` } : {},
    body: <Html html={`${intro}<div class="result-label">${escapeHtml(t.results(page.result.total))}</div>${listing}${pagination(page)}`} />,
  };
}

type Supports = { alternatives: boolean; comparisons: boolean };
export function renderClassic(page: TemplatePage, l: ClassicLayout, supports: Supports) {
  let meta: PageMeta = {}, body: ReactNode, jsonLd: unknown = null;
  if (page.kind === "detail") ({ body, jsonLd } = detail(page, supports));
  else if (page.kind === "missing") body = <Html html={l.missing(page)} />;
  else ({ meta, body } = directory(page, l));
  const parts = frameParts(page, l.layout, meta);
  const head = parts.head + (jsonLd ? `<script type="application/ld+json">${safeJson(jsonLd)}</script>` : "");
  return (
    <html lang={parts.lang}>
      <head dangerouslySetInnerHTML={{ __html: head }} />
      <body className={parts.bodyClass}>
        <main className="public directory">
          <Html html={parts.top} />
          {body}
          <Html html={parts.bottom} />
        </main>
        {parts.script ? <script type="module" src="/assets/directory.js" /> : null}
      </body>
    </html>
  );
}
