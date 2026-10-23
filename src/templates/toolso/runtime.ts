/**
 * Render-time context for the ported toolso components.
 *
 * toolso read the site, locale and messages from React context and next-intl. Templates here
 * render to static markup with no hydration, and in the Next build `react` resolves to the
 * react-server build, which has no createContext/useContext. Rendering is synchronous, so the
 * root <Document> stores the context in this module before any child component runs.
 */
import type { TemplateHomePage, TemplatePage } from "../../public/sdk.js";
import { extra } from "./i18n/extra.js";
import { messages } from "./i18n/messages.js";
import { resetIds } from "./shims/react-hooks.js";

export type AnyPage = TemplatePage | TemplateHomePage;
export type Locale = "zh" | "en";
/** Mirrors toolso's ClientSite (src/context/site-provider.tsx) for the fields Qoo.IM can supply. */
export type ClientSite = {
  id: string;
  defaultLocale: Locale;
  locales: Locale[];
  brandName: string;
  tagline: string;
  logo?: string;
  accent?: string;
  motion?: "smooth" | "crisp" | "playful" | "minimal";
  social: Record<string, string>;
};
type Context = { page: AnyPage; locale: Locale; site: ClientSite };
let current: Context | null = null;

export function provide(page: AnyPage) {
  const locale = (page.locale === "en" ? "en" : "zh") as Locale;
  const params = page.site.templateParams ?? {};
  resetIds();
  current = {
    page,
    locale,
    site: {
      id: page.catalogPath,
      defaultLocale: page.site.locales[0] ?? locale,
      locales: [...page.site.locales],
      brandName: page.site.name,
      tagline: page.site.tagline ?? "",
      accent: params.accentColor,
      motion: params.motion,
      social: {},
    },
  };
}
export function context() {
  if (!current) throw new Error("toolso component rendered outside <Document>");
  return current;
}

/** URL for a toolso-style path ("/", "/tools", "/tools/slug", "/category/x", "/tag/x", "/collection/x") on this site. */
export function localePath(path: string, locale: Locale = context().locale) {
  const { page, site } = context();
  const [pathname = "/", query] = path.split("?");
  const suffix = query ? "?" + query : "";
  if (pathname === "/" || pathname === "")
    return (locale === site.defaultLocale ? "/" : `/${locale}`) + suffix;
  const catalog = `/${locale}/${page.catalogPath}`;
  if (pathname === "/tools" || pathname === `/${page.catalogPath}`) return catalog + suffix;
  const tool = pathname.match(/^\/tools\/([a-z0-9-]+)$/);
  if (tool) return `${catalog}/${tool[1]}${suffix}`;
  if (pathname === "/category") return catalog + suffix;
  const category = pathname.match(/^\/category\/([a-z0-9-]+)$/);
  if (category) return `${catalog}/category/${category[1]}${suffix}`;
  const tag = pathname.match(/^\/tag\/([a-z0-9-]+)$/);
  if (tag) return `${catalog}/tag/${tag[1]}${suffix}`;
  const collection = pathname.match(/^\/collection\/([a-z0-9-]+)$/);
  if (collection) return `${catalog}/collection/${collection[1]}${suffix}`;
  // Account features live on fixed Qoo.IM pages.
  if (["/submit", "/dashboard", "/profile", "/favorites"].includes(pathname)) return "/me";
  if (pathname === "/login" || pathname === "/signup") return "/login";
  return pathname + suffix;
}

type Values = Record<string, string | number | Date | null | undefined>;
function lookup(locale: Locale, key: string): unknown {
  const walk = (root: unknown) =>
    key.split(".").reduce<unknown>(
      (node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined),
      root,
    );
  return walk(messages[locale]) ?? walk(extra[locale]) ?? walk(messages.en) ?? walk(extra.en);
}
// Minimal ICU: {name} and {count, plural, =0 {..} =1 {..} other {# ..}}, as used by the ported messages.
function format(message: string, values: Values, locale: Locale): string {
  let out = "";
  for (let i = 0; i < message.length; ) {
    if (message[i] !== "{") {
      out += message[i++];
      continue;
    }
    let depth = 0,
      j = i;
    for (; j < message.length; j++) {
      if (message[j] === "{") depth++;
      else if (message[j] === "}" && --depth === 0) break;
    }
    const body = message.slice(i + 1, j);
    i = j + 1;
    const plural = body.match(/^\s*(\w+)\s*,\s*plural\s*,([\s\S]*)$/);
    if (!plural) {
      const value = values[body.trim()];
      out += value instanceof Date ? value.toISOString() : String(value ?? "");
      continue;
    }
    const count = Number(values[plural[1]!] ?? 0);
    const options = new Map<string, string>();
    for (const m of plural[2]!.matchAll(/(=\d+|\w+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g))
      options.set(m[1]!, m[2]!);
    const rule = new Intl.PluralRules(locale).select(count);
    const chosen = options.get("=" + count) ?? options.get(rule) ?? options.get("other") ?? "";
    out += format(chosen.replace(/#/g, String(count)), values, locale);
  }
  return out;
}

export type Translator = ((key: string, values?: Values) => string) & {
  raw: (key: string) => unknown;
  has: (key: string) => boolean;
};
export function translator(namespace?: string, locale?: Locale): Translator {
  const ctx = context();
  const lang = locale ?? ctx.locale;
  const full = (key: string) => (namespace ? `${namespace}.${key}` : key);
  const brand = (text: string) => text.replaceAll("__BRAND__", ctx.site.brandName);
  const t = ((key: string, values: Values = {}) => {
    const message = lookup(lang, full(key));
    return typeof message === "string" ? brand(format(message, values, lang)) : full(key);
  }) as Translator;
  t.raw = (key) => lookup(lang, full(key));
  t.has = (key) => lookup(lang, full(key)) !== undefined;
  return t;
}
