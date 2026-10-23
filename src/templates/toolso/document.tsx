/**
 * Page shell: replaces toolso's [locale]/layout.tsx and Next metadata. Must be the root element
 * of every toolso page, because it installs the render context (see runtime.ts).
 */
import type { ReactNode } from "react";
import { SafeJsonLd } from "./components/safe-json-ld.js";
import { context, provide, type AnyPage } from "./runtime.js";

export type Seo = {
  title: string;
  description: string;
  image?: string | null;
  type?: "website" | "article";
  jsonLd?: unknown[];
};

export function Document({ page, seo, children }: { page: AnyPage; seo: Seo; children: ReactNode }) {
  provide(page);
  const { site } = context();
  const accent = site.accent?.slice(1).toLowerCase();
  const xDefault = page.alternates.find((a) => a.locale === site.defaultLocale);
  const image = seo.image ? new URL(seo.image, page.origin).toString() : null;
  return (
    <html lang={page.locale} data-motion={site.motion}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{seo.title}</title>
        <meta name="description" content={seo.description} />
        <link rel="canonical" href={page.canonical} />
        <meta property="og:type" content={seo.type ?? "website"} />
        <meta property="og:site_name" content={site.brandName} />
        <meta property="og:title" content={seo.title} />
        <meta property="og:description" content={seo.description} />
        <meta property="og:url" content={page.canonical} />
        {image && <meta property="og:image" content={image} />}
        <meta name="twitter:card" content={image ? "summary_large_image" : "summary"} />
        {page.noindex && <meta name="robots" content="noindex,follow" />}
        {page.alternates.map((a) => (
          <link key={a.locale} rel="alternate" hrefLang={a.locale} href={a.url} />
        ))}
        {xDefault && <link rel="alternate" hrefLang="x-default" href={xDefault.url} />}
        <link rel="preload" href="/assets/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossOrigin="" />
        <link rel="stylesheet" href="/assets/toolso.css" />
        {accent && <link rel="stylesheet" href={`/assets/theme/${accent}.css`} />}
        <script src="/assets/toolso-init.js" />
        {seo.jsonLd?.map((data, i) => <SafeJsonLd key={i} data={data} />)}
      </head>
      <body className="bg-background text-foreground antialiased min-h-screen w-full">
        {page.preview && (
          <p className="bg-primary px-4 py-2 text-center text-sm text-primary-foreground">草稿预览 · 尚未发布</p>
        )}
        {/* Status line used by /assets/directory.js for favorite and sign-out feedback. */}
        <div
          id="message"
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-[70] -translate-x-1/2 empty:hidden rounded-full border border-border bg-popover px-4 py-2 text-sm text-popover-foreground shadow-lift"
        />
        {children}
        {!page.preview && <script type="module" src="/assets/directory.js" />}
        {!page.preview && <script type="module" src="/assets/toolso.js" />}
      </body>
    </html>
  );
}
