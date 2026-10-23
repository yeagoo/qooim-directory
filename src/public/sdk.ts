/** Stable template API v1. DTOs only: no database, environment or authentication internals. */
import type { ReactElement } from "react";
export const TEMPLATE_API_VERSION = 1 as const;
export type TemplateParams = {
  accent?: "forest" | "indigo" | "terracotta";
  density?: "comfortable" | "compact";
  eyebrow?: string;
  footer?: string;
  accentColor?: string;
  motion?: "smooth" | "crisp" | "playful" | "minimal";
};
export type TemplateSite = {
  name: string;
  tagline?: string;
  locales: ("zh" | "en")[];
  navigation: { label: string; href: string }[];
  templateParams?: TemplateParams;
};
export type PublicProject = {
  provider: "github";
  repoId: string;
  fullName: string;
  stars: number;
  forks: number;
  openIssues: number;
  language: string | null;
  license: string | null;
  topics: string[];
  archived: boolean;
  pushedAt: string | null;
};
export type PublicResource = {
  project?: PublicProject | null;
  resource_id: string;
  slug: string;
  title: string;
  description: string;
  url: string;
  locale: string;
  seo_title: string;
  seo_description: string;
  image?: { url: string; alt: string } | null;
  category_id?: string | null;
  rank?: number;
  /** M13a. Square logo from the site's media library. */
  logo?: { url: string; alt: string } | null;
  /** M13a. Directory items carry only tagline and pricing; detail pages carry every field. */
  details?: PublicDetails;
  /** M13a. Every visible category of the entry, the primary one first. */
  categories?: PublicTerm[];
  tags?: PublicTerm[];
  /** M13a. ISO 8601 UTC: first publication on this site, and the latest republish. */
  published_at?: string | null;
  updated_at?: string | null;
};
export type PublicPricing = "free" | "freemium" | "paid" | "trial" | "open-source" | "contact";
export type PublicDetails = {
  tagline?: string;
  features?: string[];
  useCases?: string[];
  pros?: string[];
  cons?: string[];
  /** Untrusted Markdown. Render it with a sanitizing renderer; never insert it as HTML. */
  content?: string;
  faqs?: { question: string; answer: string }[];
  pricing?: PublicPricing;
};
export type PublicTerm = { id: string; label: string };
/** M14b. A reviewed comparison of two entries; `content` is untrusted Markdown. */
export type PublicComparison = {
  id: string;
  title: string;
  content: string;
  published_at: string | null;
  updated_at: string | null;
};
export type PublicCategory = { id: string; label: string; count: number };
/** M13b. A curated list (hot, editor's picks, ...); `count` is its visible entries in this locale. */
export type PublicCollection = PublicCategory & { description: string };
export type TemplatePage = {
  preview?: boolean;
  site: TemplateSite;
  origin: string;
  catalogPath: string;
  locale: string;
  canonical: string;
  alternates: { locale: string; url: string }[];
  noindex: boolean;
} & (
  | {
      kind: "directory";
      result: {
        total: number;
        items: PublicResource[];
        page: number;
        limit: number;
      };
      categories: PublicCategory[];
      q: string;
      category?: string;
      /** M13a. Active ?tag= filter, or the tag of a tag page. */
      tag?: string;
      /** Set when the page is a category's own URL rather than a ?category= filter. */
      categoryPage?: PublicCategory;
      /** M13a. Visible tags of this locale, and the tag of a tag page. */
      tags?: PublicCategory[];
      tagPage?: PublicCategory;
      /** M13b. The collection of a collection page; its entries keep the curated order. */
      collectionPage?: PublicCollection;
      /** M14. Set on /<slug>/alternatives: the entry whose alternatives are listed (best match first). */
      alternativesOf?: PublicResource;
      /** M14b. Set on /compare/<a>-vs-<b>: the reviewed comparison; result.items are the two entries. */
      comparison?: PublicComparison;
    }
  | {
      kind: "detail";
      item: PublicResource;
      categories?: PublicCategory[];
      related?: PublicResource[];
      /** M14b. Published comparisons that include this entry. */
      comparisons?: (PublicComparison & { other: PublicResource })[];
    }
  | { kind: "missing" }
);
type PageBase = Omit<Extract<TemplatePage, { kind: "missing" }>, "kind">;
/** Site front page; only requested from templates that implement `renderHome`. */
export type TemplateHomePage = PageBase & {
  kind: "home";
  total: number;
  featured: PublicResource[];
  categories: PublicCategory[];
  /** M13b. Visible collections, each with its first entries in curated order. */
  collections?: (PublicCollection & { items: PublicResource[] })[];
};
/** A full HTML string, or a React element rendered to static markup on the server (no hydration). */
export type TemplateOutput = string | ReactElement;
export type TemplateDefinition = {
  id: string;
  apiVersion: typeof TEMPLATE_API_VERSION;
  render: (page: TemplatePage) => TemplateOutput;
  /** Optional front page. Without it, "/" keeps rendering the default-locale directory. */
  renderHome?: (page: TemplateHomePage) => TemplateOutput;
};
export const defineTemplate = (definition: TemplateDefinition) =>
  Object.freeze(definition);
export function escapeHtml(value: unknown) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export function metadata(page: TemplatePage) {
  const title =
      page.kind === "detail"
        ? page.item.seo_title || page.item.title
        : page.site.name,
    description =
      page.kind === "detail"
        ? page.item.seo_description || page.item.description
        : (page.site.tagline ?? "");
  return `<meta name="description" content="${escapeHtml(description)}"><link rel="canonical" href="${escapeHtml(page.canonical)}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(page.canonical)}">${page.noindex ? '<meta name="robots" content="noindex,follow">' : ""}${page.alternates.map((a) => `<link rel="alternate" hreflang="${escapeHtml(a.locale)}" href="${escapeHtml(a.url)}">`).join("")}`;
}
export function resourceUrl(
  page: TemplatePage,
  item: Pick<PublicResource, "locale" | "slug">,
) {
  return `/${item.locale}/${page.catalogPath}/${item.slug}`;
}
export function header(site: TemplateSite) {
  return `<header><a href="/" class="brand">${escapeHtml(site.name)}</a><nav>${site.navigation.map((n) => `<a href="${escapeHtml(n.href)}">${escapeHtml(n.label)}</a>`).join(" · ")} <a href="/me">我的收藏与投稿</a> · <a href="/login">账号</a></nav></header><div id="message" role="status" aria-live="polite"></div>`;
}
export function projectSummary(project: PublicProject | null | undefined) {
  return project
    ? `<p class="project-facts">GitHub · ★ ${escapeHtml(project.stars)} · ${escapeHtml(project.language ?? "语言未识别")} · ${escapeHtml(project.license ?? "许可证未识别")}${project.archived ? " · 已归档" : ""}</p>`
    : "";
}
export function resourceCard(page: TemplatePage, item: PublicResource) {
  return `<article class="directory-item">${item.image ? `<img class="item-image" src="${escapeHtml(item.image.url)}" alt="${escapeHtml(item.image.alt)}" loading="lazy" decoding="async">` : ""}<div><a class="item-title" href="${escapeHtml(resourceUrl(page, item))}">${escapeHtml(item.title)}</a><p class="muted">${escapeHtml(item.description)}</p>${projectSummary(item.project)}</div><button class="secondary favorite" data-id="${escapeHtml(item.resource_id)}">收藏</button></article>`;
}
export function pagination(page: Extract<TemplatePage, { kind: "directory" }>) {
  const link = (number: number) => {
    const params = new URLSearchParams();
    if (page.q) params.set("q", page.q);
    if (page.categoryPage || page.tagPage || page.collectionPage) {
      params.set("page", String(number));
      const kind = page.categoryPage ? "category" : page.tagPage ? "tag" : "collection",
        term = (page.categoryPage ?? page.tagPage ?? page.collectionPage)!;
      return `/${page.locale}/${page.catalogPath}/${kind}/${term.id}?${params}`;
    }
    if (page.category) params.set("category", page.category);
    if (page.tag) params.set("tag", page.tag);
    params.set("page", String(number));
    return `/${page.locale}/${page.catalogPath}?${params}`;
  };
  return `<nav class="pagination" aria-label="分页">${page.result.page > 1 ? `<a class="button secondary" href="${escapeHtml(link(page.result.page - 1))}">上一页</a>` : ""}${page.result.page * page.result.limit < page.result.total ? `<a class="button secondary" href="${escapeHtml(link(page.result.page + 1))}">下一页</a>` : ""}</nav>`;
}
export function searchForm(page: Extract<TemplatePage, { kind: "directory" }>) {
  return `<form class="search" method="get" action="/${page.locale}/${escapeHtml(page.catalogPath)}"><label for="q">搜索本站资源</label><div class="row"><input id="q" name="q" value="${escapeHtml(page.q)}" maxlength="200" placeholder="输入关键词，发现新方向">${page.tag ? `<input type="hidden" name="tag" value="${escapeHtml(page.tag)}">` : ""}<select aria-label="筛选分类" name="category"><option value="">全部分类</option>${page.categories.map((c) => `<option value="${escapeHtml(c.id)}" ${page.category === c.id ? "selected" : ""}>${escapeHtml(c.label)} (${c.count})</option>`).join("")}</select><button>搜索</button></div></form>`;
}
export function detailBody(page: Extract<TemplatePage, { kind: "detail" }>) {
  return `<section class="resource-detail"><a href="/${page.locale}/${escapeHtml(page.catalogPath)}">← 全部资源</a><p class="eyebrow">精选自 ${escapeHtml(page.site.name)}</p>${page.item.image ? `<img class="detail-image" src="${escapeHtml(page.item.image.url)}" alt="${escapeHtml(page.item.image.alt)}" loading="eager" decoding="async">` : ""}<h1>${escapeHtml(page.item.title)}</h1><p class="detail-description">${escapeHtml(page.item.description)}</p>${projectSummary(page.item.project)}${page.item.project ? `<p class="muted">Forks ${escapeHtml(page.item.project.forks)} · Issues ${escapeHtml(page.item.project.openIssues)} · ${page.item.project.topics.map(escapeHtml).join(" / ")}</p>` : ""}<div class="actions">${page.item.url ? `<a class="button" href="${escapeHtml(page.item.url)}" target="_blank" rel="noopener noreferrer">访问网站 ↗</a>` : ""}<button class="secondary favorite" data-id="${escapeHtml(page.item.resource_id)}">收藏</button></div><nav>${page.alternates.map((a) => `<a href="${escapeHtml(a.url)}">${a.locale === "zh" ? "中文" : "English"}</a>`).join(" · ")}</nav></section>`;
}
export function frame(page: TemplatePage, body: string, layout = "basic") {
  const title =
    page.kind === "detail"
      ? page.item.seo_title || page.item.title
      : page.site.name;
  return `<!doctype html><html lang="${escapeHtml(page.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${metadata(page)}<link rel="stylesheet" href="/assets/network.css"><link rel="stylesheet" href="/assets/templates.css"></head><body class="template-${escapeHtml(layout)} accent-${escapeHtml(page.site.templateParams?.accent ?? "forest")} density-${escapeHtml(page.site.templateParams?.density ?? "comfortable")}"><main class="public directory">${header(page.site)}${page.preview ? '<p class="notice">草稿预览 · 尚未发布</p>' : ""}${body}<footer class="footer">${escapeHtml(page.site.templateParams?.footer ?? "由本站独立精选 · 欢迎分享你发现的好网站。")}</footer></main>${page.preview ? "" : '<script type="module" src="/assets/directory.js"></script>'}</body></html>`;
}
