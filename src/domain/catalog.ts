import type { Pool } from "pg";
import { IdentityStore } from "./identity.js";
import { z } from "zod";
import type { Config } from "./config.js";
export class NotFound extends Error {}
// A category/tag id is usable publicly when it is active and labelled in the row's locale.
const visible = (table: "category" | "tag" | "collection", id: string, alias = "p") =>
  `EXISTS(SELECT 1 FROM ${table} t WHERE t.site_id=${alias}.site_id AND t.id=${id} AND t.active AND length(trim(t.labels->>${alias}.locale))>0)`;
// Labelled, active categories/tags of a row in the row's own order.
const labelled = (table: "category" | "tag", ids: string, alias: string) =>
  `(SELECT coalesce(jsonb_agg(jsonb_build_object('id',t.id,'label',t.labels->>${alias}.locale) ORDER BY array_position(${alias}.${ids},t.id)),'[]'::jsonb)
    FROM ${table} t WHERE t.site_id=${alias}.site_id AND t.id=ANY(${alias}.${ids}) AND t.active AND length(trim(t.labels->>${alias}.locale))>0)`;
const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
/** The public columns of a public_listing row; `details` is the expression for the rich fields. */
const columns = (alias: string, details: string) =>
  [
    "resource_id,slug,title,description,url,locale,category_id,rank,version,seo_title,seo_description,project,image,logo"
      .split(",")
      .map((c) => `${alias}.${c}`)
      .join(","),
    `${details} AS details`,
    `${labelled("category", "category_ids", alias)} AS categories`,
    `${labelled("tag", "tag_ids", alias)} AS tags`,
    `${iso(alias + ".published_at")} AS published_at`,
    `${iso(alias + ".updated_at")} AS updated_at`,
  ].join(",");
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
    const slugId = z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/)
      .optional();
    const options = z
      .strictObject({
        locale: z.enum(["zh", "en"]),
        q: z.string().max(200).default(""),
        category: slugId,
        tag: slugId,
        collection: slugId,
        page: z.coerce.number().int().min(1).max(100000).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(24),
      })
      .parse(input);
    const q = options.q.trim().replace(/[%_]/g, " ").slice(0, 200);
    const collectionJoin = options.collection
      ? "LEFT JOIN collection_item ci ON ci.site_id=p.site_id AND ci.collection_id=$9 AND ci.resource_id=p.resource_id"
      : "";
    const collectionRank = options.collection ? "ci.rank" : "NULL::int";
    const collectionFilter = options.collection
      ? `AND (ci.resource_id IS NOT NULL AND ${visible("collection", "$9")})`
      : "AND $9::text IS NULL";
    // Keep the filtered CTE to raw rows and score; labels and dates are only computed
    // for the page that is actually returned. Cards get the short rich fields only.
    const { rows } = await this.pool.query(
      `WITH filtered AS (
      SELECT p.*,
        CASE WHEN $3='' THEN 0
          ELSE similarity(lower(p.title||' '||p.description||' '||p.seo_title||' '||p.seo_description),lower($3))
        END AS score,
        ${collectionRank} AS collection_rank
      FROM public_listing p
      ${collectionJoin}
      WHERE p.site_id=$1 AND p.locale=$2
      AND ($3='' OR lower(p.title||' '||p.description||' '||p.seo_title||' '||p.seo_description) LIKE '%'||lower($3)||'%')
      AND ($4::text IS NULL OR ($4=ANY(p.category_ids) AND ${visible("category", "$4")}))
      AND ($8::text IS NULL OR ($8=ANY(p.tag_ids) AND ${visible("tag", "$8")}))
      ${collectionFilter}
      AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM favorite f WHERE f.site_id=p.site_id AND f.resource_id=p.resource_id AND f.user_id=$5))
    ), paged AS(SELECT * FROM filtered ORDER BY score DESC,collection_rank,rank,slug LIMIT $6 OFFSET $7)
    SELECT (SELECT count(*)::int FROM filtered) AS total,COALESCE((SELECT jsonb_agg(to_jsonb(r)-'score'-'collection_rank' ORDER BY r.score DESC,r.collection_rank,r.rank,r.slug)
      FROM (SELECT ${columns("paged", "paged.details-ARRAY['content','faqs','features','useCases','pros','cons']")},paged.score,paged.collection_rank FROM paged) r),'[]'::jsonb) AS items`,
      [
        ctx.siteId,
        options.locale,
        q,
        options.category ?? null,
        favoriteUser ?? null,
        options.limit,
        (options.page - 1) * options.limit,
        options.tag ?? null,
        options.collection ?? null,
      ],
    );
    return { ...rows[0], page: options.page, limit: options.limit } as {
      total: number;
      items: PublicItem[];
      page: number;
      limit: number;
    };
  }
  /** First `limit` visible entries of each collection, in curated order, in one query. */
  async collectionItems(ctx: SiteContext, locale: string, ids: string[], limit: number) {
    this.check(ctx);
    if (!ids.length) return new Map<string, PublicItem[]>();
    const { rows } = await this.pool.query(
      `WITH ranked AS (
        SELECT i.collection_id,i.rank AS collection_rank,p.*,
          row_number() OVER (PARTITION BY i.collection_id ORDER BY i.rank,p.rank,p.slug) AS item_position
        FROM collection_item i
        JOIN public_listing p ON p.site_id=i.site_id AND p.resource_id=i.resource_id
        WHERE i.site_id=$1 AND i.collection_id=ANY($2::text[]) AND p.locale=$3
          AND ${visible("collection", "i.collection_id", "p")}
      ), limited AS (
        SELECT * FROM ranked WHERE item_position <= $4
      )
      SELECT collection_id,COALESCE(jsonb_agg(to_jsonb(r)-'collection_id'-'item_position' ORDER BY r.item_position),'[]'::jsonb) AS items
      FROM (SELECT limited.collection_id,limited.item_position,${columns("limited", "limited.details-ARRAY['content','faqs','features','useCases','pros','cons']")} FROM limited) r
      GROUP BY collection_id`,
      [ctx.siteId, ids, locale, limit],
    );
    return new Map(
      rows.map((row) => [row.collection_id as string, row.items as PublicItem[]]),
    );
  }
  async detail(ctx: SiteContext, locale: string, slug: string) {
    this.check(ctx);
    const row = (
      await this.pool.query(
        `SELECT ${columns("p", "p.details")} FROM public_listing p WHERE p.site_id=$1 AND p.locale=$2 AND p.slug=$3`,
        [ctx.siteId, locale, slug],
      )
    ).rows[0];
    if (!row) throw new NotFound();
    return row as PublicItem;
  }
  /** Active categories with visible entries in this locale, primary or extra. */
  categories(ctx: SiteContext, locale: string) {
    return this.taxonomy(ctx, "category", locale);
  }
  /** Active tags with visible entries in this locale. */
  tags(ctx: SiteContext, locale: string) {
    return this.taxonomy(ctx, "tag", locale);
  }
  private async taxonomy(ctx: SiteContext, table: "category" | "tag", locale: string) {
    this.check(ctx);
    const ids = table === "tag" ? "tag_ids" : "category_ids";
    return (
      await this.pool.query(
        `SELECT t.id,t.labels->>$2 AS label,count(*)::int AS count FROM ${table} t JOIN public_listing p ON p.site_id=t.site_id AND t.id=ANY(p.${ids}) AND p.locale=$2
         WHERE t.site_id=$1 AND t.active AND length(trim(t.labels->>$2))>0 GROUP BY t.id,t.labels,t.rank ORDER BY t.rank,t.id`,
        [ctx.siteId, locale],
      )
    ).rows as { id: string; label: string; count: number }[];
  }
  /** Active collections with visible entries in this locale, with their description. */
  async collections(ctx: SiteContext, locale: string) {
    this.check(ctx);
    return (
      await this.pool.query(
        `SELECT t.id,t.labels->>$2 AS label,coalesce(t.descriptions->>$2,'') AS description,count(*)::int AS count
         FROM collection t JOIN collection_item i ON i.site_id=t.site_id AND i.collection_id=t.id
         JOIN public_listing p ON p.site_id=i.site_id AND p.resource_id=i.resource_id AND p.locale=$2
         WHERE t.site_id=$1 AND t.active AND length(trim(t.labels->>$2))>0 GROUP BY t.id,t.labels,t.descriptions,t.rank ORDER BY t.rank,t.id`,
        [ctx.siteId, locale],
      )
    ).rows as { id: string; label: string; description: string; count: number }[];
  }
  /** Locales in which a category, tag or collection has visible entries, for hreflang. */
  async taxonomyLocales(ctx: SiteContext, table: "category" | "tag" | "collection", id: string) {
    this.check(ctx);
    const member =
      table === "collection"
        ? "EXISTS(SELECT 1 FROM collection_item i WHERE i.site_id=p.site_id AND i.collection_id=$2 AND i.resource_id=p.resource_id)"
        : `$2=ANY(p.${table === "tag" ? "tag_ids" : "category_ids"})`;
    return (
      await this.pool.query(
        `SELECT DISTINCT p.locale FROM public_listing p JOIN ${table} t ON t.site_id=p.site_id AND t.id=$2
         WHERE p.site_id=$1 AND ${member} AND t.active AND length(trim(t.labels->>p.locale))>0 ORDER BY p.locale`,
        [ctx.siteId, id],
      )
    ).rows.map((row) => row.locale as "zh" | "en");
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
  /** Every visible entry for the sitemap, with its latest publish time. */
  async entries(ctx: SiteContext) {
    this.check(ctx);
    return (
      await this.pool.query(
        `SELECT resource_id,locale,slug,${iso("updated_at")} AS updated_at FROM public_listing WHERE site_id=$1 ORDER BY resource_id,locale`,
        [ctx.siteId],
      )
    ).rows as { resource_id: string; locale: string; slug: string; updated_at: string | null }[];
  }
  /** Newest first by first publication, for feeds. */
  async latest(ctx: SiteContext, locale: string, limit = 50) {
    this.check(ctx);
    return (
      await this.pool.query(
        `SELECT ${columns("p", "p.details-ARRAY['content','faqs','features','useCases','pros','cons']")} FROM public_listing p
         WHERE p.site_id=$1 AND p.locale=$2 ORDER BY p.published_at DESC NULLS LAST,p.slug LIMIT $3`,
        [ctx.siteId, locale, limit],
      )
    ).rows as PublicItem[];
  }
  /**
   * Alternatives to an entry: other visible entries sharing its categories (2 points
   * each) or tags (1 point each), best overlap first.
   */
  async alternatives(ctx: SiteContext, locale: string, resourceId: string, limit = 24) {
    this.check(ctx);
    return (
      await this.pool.query(
        `WITH me AS (SELECT category_ids,tag_ids FROM public_listing WHERE site_id=$1 AND locale=$2 AND resource_id=$3),
         scored AS (
           SELECT p.*,
             2*cardinality(ARRAY(SELECT unnest(p.category_ids) INTERSECT SELECT unnest(me.category_ids)))
             +cardinality(ARRAY(SELECT unnest(p.tag_ids) INTERSECT SELECT unnest(me.tag_ids))) AS overlap
           FROM public_listing p,me
           WHERE p.site_id=$1 AND p.locale=$2 AND p.resource_id<>$3
             AND (p.category_ids && me.category_ids OR p.tag_ids && me.tag_ids)
           ORDER BY overlap DESC,p.rank,p.slug LIMIT $4)
         SELECT ${columns("scored", "scored.details-ARRAY['content','faqs','features','useCases','pros','cons']")} FROM scored ORDER BY scored.overlap DESC,scored.rank,scored.slug`,
        [ctx.siteId, locale, resourceId, limit],
      )
    ).rows as PublicItem[];
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
  image: { url: string; alt: string } | null;
  logo: { url: string; alt: string } | null;
  details: import("../public/sdk.js").PublicDetails;
  categories: import("../public/sdk.js").PublicTerm[];
  tags: import("../public/sdk.js").PublicTerm[];
  published_at: string | null;
  updated_at: string | null;
};
