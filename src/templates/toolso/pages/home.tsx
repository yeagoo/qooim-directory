import type { TemplateHomePage } from "../../../public/sdk.js";
import { Document } from "../document.js";
import { homeSeo } from "../lib/seo.js";
import { SiteChrome } from "../components/site-chrome.js";

export function HomePage({ page }: { page: TemplateHomePage }) {
  return (
    <Document page={page} seo={homeSeo(page)}>
      <SiteChrome>
      <main>
        <h1>{page.site.name}</h1>
        <ul>
          {page.featured.map((item) => (
            <li key={item.resource_id}>{item.title}</li>
          ))}
        </ul>
      </main>
      </SiteChrome>
    </Document>
  );
}
