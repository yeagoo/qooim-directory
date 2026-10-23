import type { TemplatePage } from "../../../public/sdk.js";
import { Document } from "../document.js";
import { directorySeo } from "../lib/seo.js";
import { SiteChrome } from "../components/site-chrome.js";

type Page = Extract<TemplatePage, { kind: "directory" }>;
export function DirectoryPage({ page }: { page: Page }) {

  return (
    <Document page={page} seo={directorySeo(page)}>
      <SiteChrome>
      <main>
        <h1>{page.categoryPage?.label ?? page.site.name}</h1>
        <ul>
          {page.result.items.map((item) => (
            <li key={item.resource_id}>{item.title}</li>
          ))}
        </ul>
      </main>
      </SiteChrome>
    </Document>
  );
}
