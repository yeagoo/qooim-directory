// Per-page <head> data (title, description, image, JSON-LD). Placeholder: titles only.
import type { TemplateHomePage, TemplatePage } from "../../../public/sdk.js";
import type { Seo } from "../document.js";

type Directory = Extract<TemplatePage, { kind: "directory" }>;
type Detail = Extract<TemplatePage, { kind: "detail" }>;
type Missing = Extract<TemplatePage, { kind: "missing" }>;

export const homeSeo = (page: TemplateHomePage): Seo => ({
  title: page.site.name,
  description: page.site.tagline ?? "",
});
export const directorySeo = (page: Directory): Seo => ({
  title: page.categoryPage ? `${page.categoryPage.label} · ${page.site.name}` : page.site.name,
  description: page.site.tagline ?? "",
});
export const detailSeo = (page: Detail): Seo => ({
  title: page.item.seo_title || page.item.title,
  description: page.item.seo_description || page.item.description,
  image: page.item.image?.url,
  type: "article",
});
export const missingSeo = (page: Missing): Seo => ({
  title: page.site.name,
  description: page.site.tagline ?? "",
});
