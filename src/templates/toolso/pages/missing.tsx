import type { TemplatePage } from "../../../public/sdk.js";
import { Document } from "../document.js";
import { missingSeo } from "../lib/seo.js";
import { SiteChrome } from "../components/site-chrome.js";

type Page = Extract<TemplatePage, { kind: "missing" }>;
export function MissingPage({ page }: { page: Page }) {
  return (
    <Document page={page} seo={missingSeo(page)}>
      <SiteChrome>
      <main>
        <h1>404</h1>
        {page.alternates.map((a) => (
          <a key={a.locale} href={a.url}>
            {a.locale}
          </a>
        ))}
      </main>
      </SiteChrome>
    </Document>
  );
}
