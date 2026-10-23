import { randomUUID } from "node:crypto";
import { configSchema } from "../../src/domain/config.js";
import type { Fixture } from "../p6/helpers.js";

export const XSS = `<img src=x onerror="alert(1)">`;
/** Switches atlas to the toolso template and publishes a small categorized catalog. */
export async function seedToolso(f: Fixture, params: Record<string, string> = { accentColor: "#4F46E5" }) {
  const snapshot = await f.app.sites.export(f.admin, "atlas");
  snapshot.config = configSchema.parse({
    ...snapshot.config,
    name: "Atlas 工具",
    tagline: "发现好用的工具",
    locales: ["zh", "en"],
    template: "toolso",
    templateParams: params,
  });
  await f.app.sites.save(f.admin, "atlas", snapshot, { revision: 0, draftVersion: 0 });
  await f.app.sites.publish(f.admin, "atlas", { revision: 0, draftVersion: 1 }, randomUUID());
  await f.app.content.saveCategory(f.admin, "atlas", {
    id: "design",
    labels: { zh: "设计", en: "Design" },
    expectedVersion: 0,
  });
  const resources: [string, string, string | null][] = [
    ["figma", "Figma", "design"],
    ["penpot", "Penpot", "design"],
    ["unsafe", XSS, null],
  ];
  for (const [id, title, categoryId] of resources) {
    await f.app.content.saveResource(f.admin, {
      id,
      expectedVersion: 0,
      data: {
        url: `https://example.com/${id}`,
        source: "manual",
        translations: {
          zh: { title, description: `${title} 的中文介绍` },
          en: { title, description: `${title} in English` },
        },
      },
      public: true,
    });
    for (const locale of ["zh", "en"] as const) {
      await f.app.content.stage(f.admin, "atlas", id, locale, {
        candidate: { resourceVersion: 1, slug: id, ...(categoryId ? { categoryId } : {}) },
        expected: { published: 0, draft: 0 },
      });
      await f.app.content.publish(f.admin, "atlas", id, locale, {
        expected: { published: 0, draft: 1 },
        operationId: randomUUID(),
      });
    }
  }
}
export const get = (f: Fixture, path: string, host = "atlas.p6.test") =>
  f.app.respond(new Request(`https://${host}${path}`, { headers: { host } }));
