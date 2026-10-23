import { escape, document } from "./pages.js";
type Site = { name: string; tagline?: string; locales: ("zh" | "en")[] };
type Item = {
  resource_id: string;
  slug: string;
  title: string;
  description: string;
  url: string;
  locale: string;
  seo_title: string;
  seo_description: string;
};
function metadata(
  title: string,
  description: string,
  canonical: string,
  alternates: { locale: string; url: string }[],
  noindex = false,
) {
  return `<meta name="description" content="${escape(description)}"><link rel="canonical" href="${escape(canonical)}"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${escape(canonical)}">${noindex ? '<meta name="robots" content="noindex,follow">' : ""}${alternates.map((a) => `<link rel="alternate" hreflang="${escape(a.locale)}" href="${escape(a.url)}">`).join("")}`;
}
function header(name: string) {
  return `<header><a href="/" class="brand">${escape(name)}</a><nav><a href="/me">我的收藏与投稿</a> · <a href="/login">登录</a></nav></header><div id="message" role="status" aria-live="polite"></div>`;
}
function itemCard(item: Item, path: string) {
  return `<article class="directory-item"><div><a class="item-title" href="/${escape(item.locale)}/${escape(path)}/${escape(item.slug)}">${escape(item.title)}</a><p class="muted">${escape(item.description)}</p></div><button class="secondary favorite" data-id="${escape(item.resource_id)}">收藏</button></article>`;
}
export function directoryPage(
  site: Site,
  origin: string,
  path: string,
  locale: string,
  result: { total: number; items: Item[]; page: number; limit: number },
  categories: { id: string; label: string; count: number }[],
  options: { q: string; category?: string },
) {
  const base = `/${locale}/${path}`;
  const params = new URLSearchParams();
  if (options.q) params.set("q", options.q);
  if (options.category) params.set("category", options.category);
  const pageLink = (page: number) => {
    const q = new URLSearchParams(params);
    q.set("page", String(page));
    return base + "?" + q;
  };
  const canonical =
    origin + base + (result.page > 1 ? "?page=" + result.page : "");
  return document(
    site.name,
    `<main class="public directory">${header(site.name)}<section class="directory-intro"><span class="eyebrow">INDEPENDENT FINDS, SHARED CURIOSITY</span><h1>${escape(site.name)}</h1><p class="muted">${escape(site.tagline)}</p><nav>${site.locales.map((l) => `<a href="/${l}/${escape(path)}" ${l === locale ? 'aria-current="page"' : ""}>${l === "zh" ? "中文" : "English"}</a>`).join(" · ")}</nav></section><form class="search" method="get" action="${base}"><label for="q">搜索本站资源</label><div class="row"><input id="q" name="q" value="${escape(options.q)}" maxlength="200" placeholder="输入关键词，发现新方向"><select aria-label="筛选分类" name="category"><option value="">全部分类</option>${categories.map((c) => `<option value="${escape(c.id)}" ${options.category === c.id ? "selected" : ""}>${escape(c.label)} (${c.count})</option>`).join("")}</select><button>搜索</button></div></form><div class="result-label">${result.total} 个发现</div><section class="directory-list">${result.items.map((item) => itemCard(item, path)).join("") || '<p class="empty">还没有匹配的资源，换个关键词再看看。</p>'}</section><nav class="pagination">${result.page > 1 ? `<a class="button secondary" href="${escape(pageLink(result.page - 1))}">上一页</a>` : ""}${result.page * result.limit < result.total ? `<a class="button secondary" href="${escape(pageLink(result.page + 1))}">下一页</a>` : ""}</nav><footer class="footer">由本站独立精选 · 欢迎分享你发现的好网站。</footer></main>`,
    "/assets/directory.js",
    metadata(
      site.name,
      site.tagline ?? "",
      canonical,
      site.locales.map((l) => ({ locale: l, url: origin + `/${l}/${path}` })),
      !!options.q || !!options.category,
    ),
    locale,
  );
}
export function detailPage(
  site: Site,
  origin: string,
  path: string,
  item: Item,
  alternates: { locale: string; slug: string }[],
) {
  const title = item.seo_title || item.title,
    description = item.seo_description || item.description;
  return document(
    title,
    `<main class="public">${header(site.name)}<section class="resource-detail"><a href="/${item.locale}/${escape(path)}">← 全部资源</a><p class="eyebrow">SELECTED BY ${escape(site.name)}</p><h1>${escape(item.title)}</h1><p class="detail-description">${escape(item.description)}</p><div class="actions">${item.url ? `<a class="button" href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">访问网站 ↗</a>` : ""}<button class="secondary favorite" data-id="${escape(item.resource_id)}">收藏</button></div><nav>${alternates.map((a) => `<a href="/${a.locale}/${escape(path)}/${escape(a.slug)}">${a.locale === "zh" ? "中文" : "English"}</a>`).join(" · ")}</nav></section></main>`,
    "/assets/directory.js",
    metadata(
      title,
      description,
      origin + `/${item.locale}/${path}/${item.slug}`,
      alternates.map((a) => ({
        locale: a.locale,
        url: origin + `/${a.locale}/${path}/${a.slug}`,
      })),
    ),
    item.locale,
  );
}
export function personalPage(name: string, locales: ("zh" | "en")[]) {
  return document(
    "我的收藏与投稿 · " + name,
    `<main class="public">${header(name)}<h1>收藏好发现，分享新方向。</h1><label for="personal-locale">内容语言</label><select id="personal-locale">${locales.map((l) => `<option value="${l}">${l === "zh" ? "中文" : "English"}</option>`).join("")}</select><section class="panel"><h2>我的收藏</h2><div id="favorites">正在加载…</div></section><section class="panel"><h2>推荐一个网站</h2><form id="submission"><label for="title">名称</label><input id="title" name="title" required maxlength="200"><label for="url">网站地址</label><input id="url" name="url" type="url" required><label for="description">推荐理由</label><textarea id="description" name="description" required maxlength="5000"></textarea><div class="actions"><button>提交审核</button></div></form><h2>我的投稿</h2><div id="submissions"></div></section></main>`,
    "/assets/directory.js",
    '<meta name="robots" content="noindex,nofollow">',
  );
}
export function missingPage(
  name: string,
  path: string,
  alternates: { locale: string; slug: string }[],
) {
  return document(
    "内容暂不可用 · " + name,
    `<main class="public">${header(name)}<h1>这个语言的内容暂不可用。</h1><p>可以返回本站目录，查看已发布的资源。</p><nav>${alternates.map((a) => `<a href="/${a.locale}/${escape(path)}/${escape(a.slug)}">${a.locale === "zh" ? "查看中文" : "View English"}</a>`).join(" · ")}</nav><a href="/">返回目录</a></main>`,
    undefined,
    '<meta name="robots" content="noindex,follow">',
  );
}
export type SitemapUrl = {
  loc: string;
  lastmod?: string | null;
  alternates?: { locale: string; href: string }[];
};
/** Detail URLs grouped with their language versions (hreflang). */
export function itemSitemapUrls(
  origin: string,
  path: string,
  entries: { resource_id: string; locale: string; slug: string; updated_at?: string | null }[],
): SitemapUrl[] {
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const group = groups.get(entry.resource_id) ?? [];
    group.push(entry);
    groups.set(entry.resource_id, group);
  }
  return entries.map((entry) => ({
    loc: origin + `/${entry.locale}/${path}/${entry.slug}`,
    lastmod: entry.updated_at,
    alternates: groups
      .get(entry.resource_id)!
      .map((a) => ({ locale: a.locale, href: origin + `/${a.locale}/${path}/${a.slug}` })),
  }));
}
export function sitemapXml(urls: SitemapUrl[]) {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls
    .map(
      (url) =>
        `<url><loc>${escape(url.loc)}</loc>${url.lastmod ? `<lastmod>${escape(url.lastmod)}</lastmod>` : ""}${(url.alternates ?? [])
          .map(
            (a) =>
              `<xhtml:link rel="alternate" hreflang="${escape(a.locale)}" href="${escape(a.href)}"/>`,
          )
          .join("")}</url>`,
    )
    .join("")}</urlset>`;
}
export function sitemapIndexXml(locations: string[]) {
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations
    .map((loc) => `<sitemap><loc>${escape(loc)}</loc></sitemap>`)
    .join("")}</sitemapindex>`;
}
/** RSS 2.0 feed of the newest entries in one language. */
export function rssXml(feed: {
  title: string;
  link: string;
  self: string;
  description: string;
  language: string;
  items: { title: string; link: string; description: string; published: string | null }[];
}) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${escape(feed.title)}</title><link>${escape(feed.link)}</link><atom:link href="${escape(feed.self)}" rel="self" type="application/rss+xml"/><description>${escape(feed.description)}</description><language>${escape(feed.language)}</language>${feed.items
    .map(
      (item) =>
        `<item><title>${escape(item.title)}</title><link>${escape(item.link)}</link><guid isPermaLink="true">${escape(item.link)}</guid><description>${escape(item.description)}</description>${item.published ? `<pubDate>${new Date(item.published).toUTCString()}</pubDate>` : ""}</item>`,
    )
    .join("")}</channel></rss>`;
}
