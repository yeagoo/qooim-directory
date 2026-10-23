import type { TemplatePage } from "../../../public/sdk.js";
import { Document } from "../document.js";
import { detailSeo } from "../lib/seo.js";
import { SiteChrome } from "../components/site-chrome.js";

type Page = Extract<TemplatePage, { kind: "detail" }>;
export function DetailPage({ page }: { page: Page }) {
  const item = page.item;
  return (
    <Document
      page={page}
      seo={detailSeo(page)}>
      <SiteChrome>
      <main>
        <h1>{item.title}</h1>
        <p>{item.description}</p>
        <button className="favorite" data-id={item.resource_id}>
          收藏
        </button>
      </main>
      </SiteChrome>
    </Document>
  );
}
