import type { TemplatePage, TemplateDefinition } from "../public/sdk.js";
import basic from "../templates/basic.js";
import editorial from "../templates/editorial.js";
export { templateCss, templateManifest } from "../templates/manifest.js";
const templates = new Map<string, TemplateDefinition>(
  [basic, editorial].map((template) => [template.id, template]),
);
export const templateIds = new Set(templates.keys());
export { templateParamsSchema } from "../domain/config.js";
import { templateParamsSchema } from "../domain/config.js";

export function renderTemplate(id: string, page: TemplatePage) {
  const template = templates.get(id);
  if (!template || template.apiVersion !== 1)
    throw new Error("Template unavailable or incompatible");
  const params = templateParamsSchema.parse(page.site.templateParams ?? {});
  const model = structuredClone({
    ...page,
    site: { ...page.site, templateParams: params },
  });
  const freeze = (value: unknown) => {
    if (value && typeof value === "object") {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
  };
  freeze(model);
  return appendSourceOffer(template.render(model));
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
