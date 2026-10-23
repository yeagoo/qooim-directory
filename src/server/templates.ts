import { resolve } from "node:path";
import type {
  TemplateDefinition,
  TemplateHomePage,
  TemplateOutput,
  TemplatePage,
  TemplateStaticPage,
} from "../public/sdk.js";
import basic from "../templates/basic.js";
import editorial from "../templates/editorial.js";
import toolso from "../templates/toolso/index.js";
export { templateCss, templateManifest } from "../templates/manifest.js";
const templates = new Map<string, TemplateDefinition>(
  [basic, editorial, toolso].map((template) => [template.id, template]),
);
export const templateIds = new Set(templates.keys());
// Loaded through Node at runtime: Next forbids bundling react-dom/server into route handlers,
// and the classic (non react-server) renderer is what static template markup needs.
// process.getBuiltinModule keeps webpack from rewriting the require into a bundled module.
const { renderToStaticMarkup } = process
  .getBuiltinModule("node:module")
  .createRequire(resolve("package.json"))(
  "react-dom/server",
) as typeof import("react-dom/server");
export { templateParamsSchema } from "../domain/config.js";
import { templateParamsSchema } from "../domain/config.js";

function template(id: string) {
  const found = templates.get(id);
  if (!found || found.apiVersion !== 1)
    throw new Error("Template unavailable or incompatible");
  return found;
}
function model<T extends TemplatePage | TemplateHomePage | TemplateStaticPage>(page: T): T {
  const params = templateParamsSchema.parse(page.site.templateParams ?? {});
  const result = structuredClone({
    ...page,
    site: { ...page.site, templateParams: params },
  });
  const freeze = (value: unknown) => {
    if (value && typeof value === "object") {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
  };
  freeze(result);
  return result;
}
function html(output: TemplateOutput) {
  return appendSourceOffer(
    typeof output === "string"
      ? output
      : "<!doctype html>" + renderToStaticMarkup(output),
  );
}

export function renderTemplate(id: string, page: TemplatePage) {
  return html(template(id).render(model(page)));
}
export const templateHasHome = (id: string) => !!templates.get(id)?.renderHome;
export const templateHasPage = (id: string) => !!templates.get(id)?.renderPage;
export const templateSupportsAlternatives = (id: string) =>
  !!templates.get(id)?.supports?.alternatives;
export const templateSupportsComparisons = (id: string) =>
  !!templates.get(id)?.supports?.comparisons;
export function renderHomeTemplate(id: string, page: TemplateHomePage) {
  const renderHome = template(id).renderHome;
  if (!renderHome) throw new Error("Template has no home page");
  return html(renderHome(model(page)));
}
export function renderPageTemplate(id: string, page: TemplateStaticPage) {
  const renderPage = template(id).renderPage;
  if (!renderPage) throw new Error("Template has no static page");
  return html(renderPage(model(page)));
}

// Keep custom templates compatible with valid uppercase or omitted HTML end tags.
export function appendSourceOffer(html: string) {
  const footer =
    '<footer class="footer" aria-label="Source"><a href="/source.tar.gz">获取本部署源码 · AGPL-3.0</a></footer>';
  if (/<\/body\s*>/i.test(html))
    return html.replace(/<\/body\s*>/i, footer + "$&");
  if (/<\/html\s*>/i.test(html))
    return html.replace(/<\/html\s*>/i, footer + "$&");
  return html + footer;
}
