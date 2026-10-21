import type { Pool } from "pg";
import { IdentityStore } from "./identity.js";
import { z } from "zod";
import type { Config } from "./config.js";
export class NotFound extends Error {}
export type SiteContext = Readonly<{ siteId: string; host: string }>;
export class Catalog {
  private contexts = new WeakSet<object>();
  private cache = new Map<
    string,
    { until: number; revision: number; config: Config }
  >();
  constructor(
    private pool: Pool,
    private ttl = 5000,
  ) {}
  async resolve(host: string | undefined): Promise<SiteContext> {
    if (!host || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?$/i.test(host))
      throw new NotFound();
    const hostname = host.toLowerCase().split(":")[0];
    const r = await this.pool.query(
      "SELECT id FROM site WHERE host=$1 AND active",
      [hostname],
    );
    if (!r.rows.length) throw new NotFound();
    const ctx = Object.freeze({
      siteId: r.rows[0].id as string,
      host: hostname,
    });
    this.contexts.add(ctx);
    return ctx;
  }
  invalidate(siteId: string) {
    this.cache.delete(siteId);
  }
  private check(ctx: SiteContext) {
    if (!this.contexts.has(ctx)) throw new NotFound();
  }
  async configuration(ctx: SiteContext) {
    this.check(ctx);
    const cached = this.cache.get(ctx.siteId);
    if (cached && cached.until > Date.now()) return cached;
    const { rows } = await this.pool.query(
      "SELECT revision,config FROM site WHERE id=$1 AND active",
      [ctx.siteId],
    );
    if (!rows.length) throw new NotFound();
    const value = {
      until: Date.now() + this.ttl,
      revision: rows[0].revision as number,
      config: rows[0].config as Config,
    };
    this.cache.set(ctx.siteId, value);
    return value;
  }
  async preview(ctx: SiteContext, locale: string, credential: string) {
    this.check(ctx);
    if (
      !/^[0-9a-f-]{36}$/.test(credential) ||
      !(await new IdentityStore(this.pool).authorize(
        credential,
        ctx.siteId,
        "editor",
      ))
    )
      throw new NotFound();
    const { rows } = await this.pool.query(
      "SELECT slug,title,locale FROM publication WHERE site_id=$1 AND locale=$2 ORDER BY slug",
      [ctx.siteId, locale],
    );
    return rows as { slug: string; title: string; locale: string }[];
  }
  async sitemap(ctx: SiteContext) {
    const { config } = await this.configuration(ctx);
    const groups = await Promise.all(
      config.locales.map((locale) => this.list(ctx, locale)),
    );
    return groups.flat().map((item) => ({
      locale: item.locale,
      url: `https://${ctx.host}/${item.locale}/${config.catalogPath}/${item.slug}`,
    }));
  }
  async list(ctx: SiteContext, locale: string, slug?: string) {
    this.check(ctx);
    // Never return an internal row or memoize visibility. The gate is in the same query.
    const { rows } = await this.pool.query(
      `SELECT slug,title,locale FROM public_listing
       WHERE site_id=$1 AND locale=$2 AND ($3::text IS NULL OR slug=$3) ORDER BY slug LIMIT 100`,
      [ctx.siteId, locale, slug ?? null],
    );
    return rows as { slug: string; title: string; locale: string }[];
  }
  async browse(ctx: SiteContext, input: unknown, favoriteUser?: string) {
    this.check(ctx);
    const options = z
      .strictObject({
        locale: z.enum(["zh", "en"]),
        q: z.string().max(200).default(""),
        category: z
          .string()
          .regex(/^[a-z][a-z0-9-]{0,63}$/)
          .optional(),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(24),
      })
      .parse(input);
    const q = options.q.trim().replace(/[%_]/g, " ").slice(0, 200);
    const { rows } = await this.pool.query(
      `WITH filtered AS (
      SELECT p.resource_id,p.slug,p.title,p.description,p.url,p.locale,p.category_id,p.rank,p.version,p.seo_title,p.seo_description,p.project,
        CASE WHEN $3='' THEN 0
          ELSE similarity(lower(p.title||' '||p.description||' '||p.seo_title||' '||p.seo_description),lower($3))
        END AS score
      FROM public_listing p
      WHERE p.site_id=$1 AND p.locale=$2
      AND ($3='' OR lower(p.title||' '||p.description||' '||p.seo_title||' '||p.seo_description) LIKE '%'||lower($3)||'%')
      AND ($4::text IS NULL OR p.category_id=$4)
      AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM favorite f WHERE f.site_id=p.site_id AND f.resource_id=p.resource_id AND f.user_id=$5))
    ), paged AS(SELECT * FROM filtered ORDER BY score DESC,rank,slug LIMIT $6 OFFSET $7)
    SELECT (SELECT count(*)::int FROM filtered) AS total,COALESCE((SELECT jsonb_agg(to_jsonb(paged)-'score' ORDER BY score DESC,rank,slug) FROM paged),'[]'::jsonb) AS items`,
      [
        ctx.siteId,
        options.locale,
        q,
        options.category ?? null,
        favoriteUser ?? null,
        options.limit,
        (options.page - 1) * options.limit,
      ],
    );
    return { ...rows[0], page: options.page, limit: options.limit } as {
      total: number;
      items: PublicItem[];
      page: number;
      limit: number;
    };
  }
  async detail(ctx: SiteContext, locale: string, slug: string) {
    this.check(ctx);
    const row = (
      await this.pool.query(
        "SELECT resource_id,slug,title,description,url,locale,category_id,rank,version,seo_title,seo_description,project FROM public_listing WHERE site_id=$1 AND locale=$2 AND slug=$3",
        [ctx.siteId, locale, slug],
      )
    ).rows[0];
    if (!row) throw new NotFound();
    return row as PublicItem;
  }
  async categories(ctx: SiteContext, locale: string) {
    this.check(ctx);
    return (
      await this.pool.query(
        `SELECT c.id,c.labels->>$2 AS label,count(*)::int AS count FROM category c JOIN public_listing p ON p.site_id=c.site_id AND p.category_id=c.id AND p.locale=$2 WHERE c.site_id=$1 GROUP BY c.id,c.labels,c.rank ORDER BY c.rank,c.id`,
        [ctx.siteId, locale],
      )
    ).rows as { id: string; label: string; count: number }[];
  }
  async alternates(ctx: SiteContext, resource: string) {
    this.check(ctx);
    return (
      await this.pool.query(
        "SELECT locale,slug FROM public_listing WHERE site_id=$1 AND resource_id=$2 ORDER BY locale",
        [ctx.siteId, resource],
      )
    ).rows as { locale: string; slug: string }[];
  }
  async availableForSlug(ctx: SiteContext, slug: string) {
    this.check(ctx);
    return (
      await this.pool.query(
        "SELECT locale,slug FROM public_listing WHERE site_id=$1 AND resource_id IN(SELECT resource_id FROM public_listing WHERE site_id=$1 AND slug=$2) ORDER BY locale,slug",
        [ctx.siteId, slug],
      )
    ).rows as { locale: string; slug: string }[];
  }
  async entries(ctx: SiteContext) {
    this.check(ctx);
    return (
      await this.pool.query(
        "SELECT resource_id,locale,slug FROM public_listing WHERE site_id=$1 ORDER BY resource_id,locale LIMIT 50001",
        [ctx.siteId],
      )
    ).rows as { resource_id: string; locale: string; slug: string }[];
  }
}

export type PublicItem = {
  project?: import("../public/sdk.js").PublicProject | null;
  resource_id: string;
  slug: string;
  title: string;
  description: string;
  url: string;
  locale: string;
  category_id: string | null;
  rank: number;
  version: number;
  seo_title: string;
  seo_description: string;
};
