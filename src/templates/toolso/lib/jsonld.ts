// Ported from toolso-ai-open src/lib/seo/jsonld.ts and src/components/json-ld.tsx (Apache-2.0, Copyright 2025 CoolChange.AI).
// Changes: the WebSite/Organization components became plain builders (Document renders every
// object through SafeJsonLd); callers pass absolute URLs built from the page DTO instead of the
// toolso site registry; fields Qoo.IM has no data for (offers/pricing, applicationCategory,
// operatingSystem, logo, sameAs) are left out instead of being guessed. See NOTICE.md.
// The Article builder comes from app/[locale]/(marketing)/compare/[slug]/page.tsx (inline jsonLd object there).
/**
 * Schema.org JSON-LD builders. Return plain objects only; <SafeJsonLd> escapes them.
 * Optional fields are `undefined` so JSON.stringify drops them (never write `null`).
 */
const SCHEMA = "https://schema.org";

export function inLanguage(locale: string): string {
  switch (locale) {
    case "zh":
      return "zh-CN";
    case "zh-tw":
      return "zh-TW";
    case "en":
      return "en-US";
    default:
      return locale;
  }
}

/* ============ BreadcrumbList ============ */

export interface BreadcrumbItem {
  name: string;
  url: string;
}

export function buildBreadcrumbList(items: BreadcrumbItem[]) {
  return {
    "@context": SCHEMA,
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}

/* ============ SoftwareApplication ============ */

export interface ToolJsonLdInput {
  url: string;
  name: string;
  description: string;
  image?: string | null;
  /** Category label in the page locale. */
  applicationSubCategory?: string | null;
}

export function buildSoftwareApplication(t: ToolJsonLdInput) {
  return {
    "@context": SCHEMA,
    "@type": "SoftwareApplication",
    name: t.name,
    description: t.description || undefined,
    url: t.url,
    image: t.image || undefined,
    applicationSubCategory: t.applicationSubCategory || undefined,
  };
}

/* ============ ItemList ============ */

export interface ItemListEntry {
  url: string;
  name: string;
}

export function buildItemList(name: string, items: ItemListEntry[]) {
  return {
    "@context": SCHEMA,
    "@type": "ItemList",
    name,
    numberOfItems: items.length,
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: it.url,
      name: it.name,
    })),
  };
}

/* ============ Article (compare/[slug]/page.tsx) ============ */

export function buildComparisonArticle(input: {
  headline: string;
  description: string;
  url: string;
  about: { name: string; url?: string }[];
}) {
  return {
    "@context": SCHEMA,
    "@type": "Article",
    headline: input.headline,
    description: input.description,
    url: input.url,
    about: input.about.map((a) => ({ "@type": "SoftwareApplication", name: a.name, url: a.url })),
  };
}

/* ============ FAQPage ============ */

export interface FaqEntry {
  q: string;
  a: string;
}

export function buildFaqPage(entries: FaqEntry[]) {
  return {
    "@context": SCHEMA,
    "@type": "FAQPage",
    mainEntity: entries.map((e) => ({
      "@type": "Question",
      name: e.q,
      acceptedAnswer: { "@type": "Answer", text: e.a },
    })),
  };
}

/* ============ WebSite (was <WebSiteJsonLd>) ============ */

export interface WebSiteJsonLdInput {
  name: string;
  description?: string;
  url: string;
  locale: string;
  /** Search results URL; `{search_term_string}` is appended as the `q` parameter. */
  searchUrl: string;
}

export function buildWebSite(w: WebSiteJsonLdInput) {
  return {
    "@context": SCHEMA,
    "@type": "WebSite",
    name: w.name,
    description: w.description || undefined,
    url: w.url,
    inLanguage: inLanguage(w.locale),
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${w.searchUrl}?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}

/* ============ Organization (was <OrganizationJsonLd>) ============ */

export interface OrganizationJsonLdInput {
  name: string;
  url: string;
  logo?: string | null;
}

export function buildOrganization(o: OrganizationJsonLdInput) {
  return {
    "@context": SCHEMA,
    "@type": "Organization",
    name: o.name,
    url: o.url,
    logo: o.logo || undefined,
  };
}
