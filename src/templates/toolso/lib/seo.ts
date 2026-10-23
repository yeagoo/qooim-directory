// Ported from toolso-ai-open src/lib/metadata.ts (title template, __BRAND__ substitution) and the
// generateMetadata/JSON-LD blocks of src/app/[locale]/(marketing)/{page,tools/page,category/[slug]/page,hot/page,
// tools/[slug]/page}.tsx (Apache-2.0, Copyright 2025 CoolChange.AI).
// Changes: computed from the template page DTO only. These functions run while the props for
// <Document> are built, i.e. before Document calls provide(), so they must not touch the render
// context (context()/translator()/localePath()); messages are looked up with the page's own locale.
// Titles get the "%s · Brand" template unless they already contain the brand. See NOTICE.md.
import type {
  PublicCategory,
  PublicResource,
  TemplateHomePage,
  TemplatePage,
  TemplateStaticPage,
} from "../../../public/sdk.js";
import type { Seo } from "../document.js";
import { messages } from "../i18n/messages.js";
import { extra } from "../i18n/extra.js";
import {
  buildBreadcrumbList,
  buildFaqPage,
  buildComparisonArticle,
  buildItemList,
  buildOrganization,
  buildSoftwareApplication,
  buildWebSite,
  type BreadcrumbItem,
} from "./jsonld.js";

type Directory = Extract<TemplatePage, { kind: "directory" }>;
type Detail = Extract<TemplatePage, { kind: "detail" }>;
type Missing = Extract<TemplatePage, { kind: "missing" }>;
type Base = Pick<TemplateHomePage, "site" | "origin" | "catalogPath" | "locale">;
type Locale = keyof typeof messages;

const localeOf = (page: Base): Locale => (page.locale === "en" ? "en" : "zh");

/** messages lookup with the same fallback as runtime.ts (page locale, then en), plus {name} values and __BRAND__. */
function message(page: Base, key: string, values: Record<string, string | number> = {}): string {
  const walk = (root: unknown) =>
    key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined),
        root,
      );
  const locale = localeOf(page);
  const found = walk(messages[locale]) ?? walk(extra[locale]) ?? walk(messages.en) ?? walk(extra.en);
  const text = typeof found === "string" ? found : key;
  return text
    .replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole))
    .replaceAll("__BRAND__", page.site.name);
}

/** toolso generatePageMetadata: apply the per-site title template unless the brand is already there. */
function titled(page: Base, title: string) {
  const brand = page.site.name;
  if (!title) return brand;
  return title.includes(brand) ? title : `${title} · ${brand}`;
}

// Absolute URLs, matching runtime.ts localePath(): the default locale's home is "/", others "/<locale>".
const homeUrl = (page: Base) =>
  page.origin + (page.locale === (page.site.locales[0] ?? page.locale) ? "/" : `/${page.locale}`);
const catalogUrl = (page: Base) => `${page.origin}/${page.locale}/${page.catalogPath}`;
const categoryUrl = (page: Base, id: string) => `${catalogUrl(page)}/category/${encodeURIComponent(id)}`;
const tagUrl = (page: Base, id: string) => `${catalogUrl(page)}/tag/${encodeURIComponent(id)}`;
const collectionUrl = (page: Base, id: string) => `${catalogUrl(page)}/collection/${encodeURIComponent(id)}`;
const itemUrl = (page: Base, item: Pick<PublicResource, "locale" | "slug">) =>
  `${page.origin}/${item.locale}/${page.catalogPath}/${item.slug}`;
const absolute = (page: Base, url: string | null | undefined) => {
  if (!url) return undefined;
  try {
    return new URL(url, page.origin).toString();
  } catch {
    return undefined;
  }
};

const homeCrumb = (page: Base): BreadcrumbItem => ({ name: message(page, "tools.detail.home"), url: homeUrl(page) });
const catalogCrumb = (page: Base): BreadcrumbItem => ({ name: message(page, "tools.title"), url: catalogUrl(page) });

export function homeSeo(page: TemplateHomePage): Seo {
  const tagline = page.site.tagline?.trim();
  return {
    title: tagline ? titled(page, tagline) : page.site.name,
    description: tagline || message(page, "seo.tools.description"),
    jsonLd: [
      buildWebSite({
        name: page.site.name,
        description: tagline,
        url: homeUrl(page),
        locale: page.locale,
        searchUrl: catalogUrl(page),
      }),
      buildOrganization({ name: page.site.name, url: page.origin + "/" }),
    ],
  };
}

export function directorySeo(page: Directory): Seo {
  if (page.comparison) {
    const comparison = page.comparison;
    const names = page.result.items.map((item) => item.title).join(" vs ");
    // First plain paragraph of the Markdown body, else "A vs B".
    const paragraph = comparison.content
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .find((block) => block && !/^(#|\||[-*+] |\d+\. |>|```)/.test(block));
    const description = paragraph
      ? paragraph.replace(/[*_`[\]]|\(([^)]*)\)/g, "").replace(/\s+/g, " ").slice(0, 160)
      : names;
    return {
      title: titled(page, comparison.title),
      description,
      type: "article",
      jsonLd: [
        buildComparisonArticle({
          headline: comparison.title,
          description,
          url: page.canonical,
          about: page.result.items.map((item) => ({ name: item.title, url: item.url || undefined })),
        }),
        buildBreadcrumbList([homeCrumb(page), catalogCrumb(page), { name: comparison.title, url: page.canonical }]),
      ],
    };
  }
  if (page.alternativesOf) {
    const tool = page.alternativesOf;
    const title = message(page, "tools.detail.altPageTitle", { tool: tool.title });
    return {
      title: titled(page, title),
      description: message(page, "tools.detail.altPageSubtitle", { tool: tool.title, count: page.result.items.length }),
      jsonLd: [
        buildBreadcrumbList([
          homeCrumb(page),
          catalogCrumb(page),
          { name: tool.title, url: itemUrl(page, tool) },
          { name: message(page, "tools.detail.alternatives"), url: page.canonical },
        ]),
        buildItemList(
          title,
          page.result.items.map((item) => ({ name: item.title, url: itemUrl(page, item) })),
        ),
      ],
    };
  }
  const category: PublicCategory | undefined = page.categoryPage;
  const tag: PublicCategory | undefined = page.tagPage;
  const pageSuffix = page.result.page > 1 ? ` · ${message(page, "tools.category.page", { page: page.result.page })}` : "";
  const listName = category ? category.label : message(page, "tools.title");
  const items = page.result.items.map((item) => ({ name: item.title, url: itemUrl(page, item) }));
  if (category) {
    const browse = message(page, "tools.category.browseCategory", { category: category.label });
    return {
      // toolso: `${category.name} · ${browseCategory}`
      title: titled(page, `${category.label} · ${browse}${pageSuffix}`),
      description: browse,
      jsonLd: [
        buildBreadcrumbList([
          homeCrumb(page),
          catalogCrumb(page),
          { name: category.label, url: categoryUrl(page, category.id) },
        ]),
        buildItemList(listName, items),
      ],
    };
  }
  const collection = page.collectionPage;
  if (collection) {
    return {
      title: titled(page, `${collection.label}${pageSuffix}`),
      description: collection.description || collection.label,
      jsonLd: [
        buildBreadcrumbList([homeCrumb(page), catalogCrumb(page), { name: collection.label, url: collectionUrl(page, collection.id) }]),
        buildItemList(collection.label, items),
      ],
    };
  }
  if (tag) {
    const browse = message(page, "qooim.catalog.tag.browseTag", { tag: `#${tag.label}` });
    return {
      title: titled(page, `${browse}${pageSuffix}`),
      description: browse,
      jsonLd: [
        buildBreadcrumbList([homeCrumb(page), catalogCrumb(page), { name: `#${tag.label}`, url: tagUrl(page, tag.id) }]),
        buildItemList(`#${tag.label}`, items),
      ],
    };
  }
  return {
    title: titled(page, (page.q ? `${page.q} · ` : "") + listName + pageSuffix),
    description: page.site.tagline?.trim() || message(page, "seo.tools.description"),
    jsonLd: [buildItemList(listName, items)],
  };
}

export function detailSeo(page: Detail): Seo {
  const item = page.item;
  const category = item.category_id ? page.categories?.find((c) => c.id === item.category_id) : undefined;
  const url = itemUrl(page, item);
  const description = item.seo_description || item.description || `${message(page, "tools.subtitle")} - ${item.title}`;
  const faqs = item.details?.faqs ?? [];
  return {
    // An editor's SEO title wins; otherwise toolso's `${tool.name} - ${listLabel}`.
    title: titled(page, item.seo_title || `${item.title} - ${message(page, "tools.title")}`),
    description,
    image: item.image?.url ?? item.logo?.url,
    type: "article",
    jsonLd: [
      buildSoftwareApplication({
        name: item.title,
        description: item.description || item.seo_description,
        url: item.url || url,
        image: absolute(page, item.logo?.url ?? item.image?.url),
        applicationSubCategory: category?.label,
      }),
      buildBreadcrumbList([
        homeCrumb(page),
        catalogCrumb(page),
        ...(category ? [{ name: category.label, url: categoryUrl(page, category.id) }] : []),
        { name: item.title, url },
      ]),
      ...(faqs.length > 0 ? [buildFaqPage(faqs.map((f) => ({ q: f.question, a: f.answer })))] : []),
    ],
  };
}

export function missingSeo(page: Missing): Seo {
  return {
    title: titled(page, message(page, "errors.404.title")),
    description: message(page, "errors.404.message"),
  };
}

export function staticSeo(page: TemplateStaticPage): Seo {
  const description = page.content
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^(#|\||[-*+] |\d+\. |>|```)/.test(block))
    ?.replace(/[*_`[\]]|\(([^)]*)\)/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return {
    title: titled(page, page.title),
    description: description || page.title,
    type: "article",
  };
}
