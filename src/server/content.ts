import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "../domain/transaction.js";
import { activeProjectSite } from "./module-gate.js";
import { projectSchema, sourceFields } from "../domain/project.js";
import { Conflict } from "../domain/config.js";
import { Operators, HttpError, type Operator } from "./operators.js";
export const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const localeSchema = z.enum(["zh", "en"]);
const text = z.string().trim().min(1).max(200);
const description = z.string().trim().min(1).max(5000);
const webUrl = z
  .url()
  .max(2048)
  .refine((v) => {
    const u = new URL(v);
    return (
      ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
    );
  }, "Only public HTTP(S) links without credentials");
const bullet = z.string().trim().min(1).max(300);
const bullets = z.array(bullet).max(12);
// Rich listing fields (M13a) are optional per locale; Markdown content is rendered by templates.
const translation = z.strictObject({
  title: text,
  description,
  tagline: z.string().trim().max(160).optional(),
  features: bullets.optional(),
  useCases: bullets.optional(),
  pros: bullets.optional(),
  cons: bullets.optional(),
  content: z.string().trim().max(50000).optional(),
  faqs: z
    .array(
      z.strictObject({
        question: z.string().trim().min(1).max(300),
        answer: z.string().trim().min(1).max(3000),
      }),
    )
    .max(20)
    .optional(),
});
export const pricingSchema = z.enum([
  "free",
  "freemium",
  "paid",
  "trial",
  "open-source",
  "contact",
]);
const mediaRef = z.strictObject({
  mediaId: z.uuid(),
  alt: z.string().max(200).default(""),
});
export const resourceData = z
  .strictObject({
    url: webUrl,
    kind: z.enum(["website", "repository"]).default("website"),
    project: projectSchema.optional(),
    source: z.string().max(500).default(""),
    pricing: pricingSchema.optional(),
    translations: z
      .strictObject({ zh: translation.optional(), en: translation.optional() })
      .refine(
        (v) => Object.keys(v).length > 0,
        "At least one translation required",
      ),
  })
  .refine(
    (v) => (v.kind === "repository" ? !!v.project : !v.project),
    "Repository metadata must match resource kind",
  );
export const candidateSchema = z.strictObject({
  resourceVersion: z.number().int().positive(),
  slug: identifier,
  categoryId: identifier.nullable().default(null),
  // Categories besides the primary categoryId, and this site's tags.
  // Optional rather than defaulted, so drafts saved before M13a round-trip unchanged.
  extraCategoryIds: z.array(identifier).max(10).optional(),
  tagIds: z.array(identifier).max(20).optional(),
  rank: z.number().int().min(-100000).max(100000).default(0),
  overrides: z
    .strictObject({
      title: text.optional(),
      description: description.optional(),
      url: webUrl.optional(),
      seoTitle: z.string().max(200).optional(),
      seoDescription: z.string().max(500).optional(),
      tagline: z.string().trim().max(160).optional(),
      content: z.string().trim().max(50000).optional(),
      image: mediaRef.nullable().optional(),
      logo: mediaRef.nullable().optional(),
    })
    .default({}),
});
const expectedSchema = z.strictObject({
  published: z.number().int().nonnegative(),
  draft: z.number().int().nonnegative(),
});
type Expected = z.infer<typeof expectedSchema>;
export const resourceInput = z.strictObject({
  id: identifier,
  expectedVersion: z.number().int().nonnegative(),
  data: resourceData,
  public: z.boolean().default(true),
  internalNote: z.string().max(5000).default(""),
});
const bundleSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("resources"),
    resources: z.array(resourceInput).max(100),
  })
  .refine(
    (v) => new Set(v.resources.map((r) => r.id)).size === v.resources.length,
    "Duplicate resource id",
  );
// The candidate a published row was made from (site fields only; resourceVersion is set by the caller).
// Extra categories and tags are included only when present, so pre-M13a entries keep their shape.
function publishedCandidate(row: {
  slug: string;
  category_id: string | null;
  category_ids?: string[] | null;
  tag_ids?: string[] | null;
  rank: number;
  overrides: unknown;
}) {
  const extra = (row.category_ids ?? []).filter((id) => id !== row.category_id);
  return {
    slug: row.slug,
    categoryId: row.category_id,
    ...(extra.length ? { extraCategoryIds: extra } : {}),
    ...(row.tag_ids?.length ? { tagIds: row.tag_ids } : {}),
    rank: row.rank,
    overrides: row.overrides,
  };
}
export class Content {
  readonly operators: Operators;
  constructor(private pool: Pool) {
    this.operators = new Operators(pool);
  }
  private async audit(
    c: PoolClient,
    actor: Operator,
    site: string | null,
    action: string,
    detail: unknown,
  ) {
    await c.query(
      "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,$3,$4)",
      [actor.id, site, action, detail],
    );
  }
  private async writeResource(
    c: PoolClient,
    actor: Operator,
    value: z.infer<typeof resourceInput>,
    reviewSite?: string,
  ) {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "resource:" + value.id,
    ]);
    const row = (
      await c.query("SELECT version FROM resource WHERE id=$1 FOR UPDATE", [
        value.id,
      ])
    ).rows[0];
    // Only the internal submission-review path may create a master with site authority.
    await this.operators.require(
      actor,
      reviewSite,
      reviewSite !== undefined,
      c,
    );
    if ((row?.version ?? 0) !== value.expectedVersion)
      throw new Conflict("Resource version changed");
    const version = value.expectedVersion + 1;
    if (row)
      await c.query(
        "UPDATE resource SET version=$2,data=$3,public=$4,internal_note=$5 WHERE id=$1",
        [value.id, version, value.data, value.public, value.internalNote],
      );
    else
      await c.query(
        "INSERT INTO resource(id,version,data,public,internal_note) VALUES($1,$2,$3,$4,$5)",
        [value.id, version, value.data, value.public, value.internalNote],
      );
    await c.query("INSERT INTO resource_revision VALUES($1,$2,$3)", [
      value.id,
      version,
      value.data,
    ]);
    await this.audit(c, actor, null, "resource.save", {
      id: value.id,
      version,
    });
    return version;
  }
  // Internal source services use this narrow DAL entry; public routes never query masters directly.
  async sourceBase(c: PoolClient, id: string) {
    return (
      await c.query(
        "SELECT version,data,public,internal_note FROM resource WHERE id=$1",
        [identifier.parse(id)],
      )
    ).rows[0] as
      | {
          version: number;
          data: z.infer<typeof resourceData> | null;
          public: boolean;
          internal_note: string;
        }
      | undefined;
  }
  // GitHub sync (binding collector source, collector_source kind 'github') is a
  // system writer. Stats are the only fields allowed to bypass human review;
  // content changes still go through github_candidate.
  async applySourceStats(
    c: PoolClient,
    source: { id: string; site_id: string; resource_id: string },
    remote: {
      stars: number;
      forks: number;
      openIssues: number;
      pushedAt: string | null;
    },
  ) {
    const keys = ["stars", "forks", "openIssues", "pushedAt"] as const;
    const current = (
      await c.query("SELECT version,data FROM resource WHERE id=$1 FOR UPDATE", [
        source.resource_id,
      ])
    ).rows[0];
    const data = current?.data;
    if (!data || data.kind !== "repository" || !data.project) return false;
    if (keys.every((key) => data.project[key] === remote[key])) return false;
    const next = structuredClone(data);
    for (const key of keys) next.project[key] = remote[key];
    const version = Number(current.version) + 1;
    await c.query("UPDATE resource SET data=$2,version=$3 WHERE id=$1", [
      source.resource_id,
      next,
      version,
    ]);
    await c.query(
      `UPDATE github_candidate
       SET base_version=base_version+1,
           data=jsonb_set(data,'{project}',$2::jsonb,true)
       WHERE source_id=$1 AND status='pending'`,
      [source.id, JSON.stringify(next.project)],
    );
    await c.query(
      `UPDATE publication
       SET project=COALESCE(project,'{}'::jsonb) || $2::jsonb
       WHERE resource_id=$1 AND project IS NOT NULL`,
      [source.resource_id, JSON.stringify(remote)],
    );
    await c.query(
      "INSERT INTO audit_event(site_id,action,detail) VALUES($1,'github.stats',$2)",
      [
        source.site_id,
        { resourceId: source.resource_id, version, fields: [...keys] },
      ],
    );
    return true;
  }
  async reviewGithub(actor: Operator, input: unknown) {
    await this.operators.require(actor);
    const v = z
      .strictObject({
        candidateId: z.uuid(),
        expectedCandidateVersion: z.number().int().positive(),
        expectedResourceVersion: z.number().int().nonnegative(),
        decision: z.enum(["accept", "reject"]),
        fields: sourceFields,
      })
      .parse(input);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ ...v, fields: [...v.fields].sort() }))
      .digest("hex");
    return transaction(this.pool, async (c) => {
      const initial = (
        await c.query(
          "SELECT s.site_id,s.id FROM github_candidate gc JOIN collector_source s ON s.id=gc.source_id AND s.kind='github' WHERE gc.id=$1",
          [v.candidateId],
        )
      ).rows[0];
      if (!initial) throw new HttpError(404, "同步候选不存在");
      await activeProjectSite(c, initial.site_id);
      const source = (
        await c.query("SELECT * FROM collector_source WHERE id=$1 FOR UPDATE", [
          initial.id,
        ])
      ).rows[0];
      const candidate = (
        await c.query("SELECT * FROM github_candidate WHERE id=$1 FOR UPDATE", [
          v.candidateId,
        ])
      ).rows[0];
      await this.operators.require(actor, undefined, false, c);
      if (candidate.review_fingerprint === fingerprint)
        return { status: candidate.status, version: candidate.applied_version };
      if (
        candidate.status !== "pending" ||
        candidate.version !== v.expectedCandidateVersion ||
        candidate.source_version !== source.version ||
        !source.enabled
      )
        throw new Conflict("同步候选或来源已改变，请重新查看");
      let version: number | null = null;
      if (v.decision === "accept") {
        const remote = resourceData.parse(candidate.data),
          old = await this.sourceBase(c, source.resource_id);
        if ((old?.version ?? 0) !== v.expectedResourceVersion)
          throw new Conflict("主档已改变，请重新比较");
        const data = old?.data
          ? structuredClone(resourceData.parse(old.data))
          : ({
              kind: "website" as "website" | "repository",
              url: "",
              source: "",
              translations: {},
            } as z.infer<typeof resourceData>);
        if (!data.url.trim() && !v.fields.includes("url"))
          throw new HttpError(
            400,
            "该来源还没有资源网址；接受 project 前请先填写 url，或同时选择 url 字段",
          );
        for (const field of v.fields) {
          if (field === "project") {
            data.kind = "repository";
            data.project = remote.project;
          } else if (field === "url") data.url = remote.url;
          else if (field === "source") data.source = remote.source;
          else {
            const key =
              field === "translations.en.title" ? "title" : "description";
            data.translations.en ??= { title: "", description: "" };
            data.translations.en[key] = remote.translations.en![key];
          }
        }
        version = await this.writeResource(
          c,
          actor,
          resourceInput.parse({
            id: source.resource_id,
            expectedVersion: v.expectedResourceVersion,
            data,
            public: old?.public ?? true,
            internalNote: old?.internal_note ?? "",
          }),
        );
      }
      const status = v.decision === "accept" ? "accepted" : "rejected";
      await c.query(
        "UPDATE github_candidate SET status=$2,version=version+1,applied_version=$3,review_fingerprint=$4 WHERE id=$1",
        [candidate.id, status, version, fingerprint],
      );
      await this.audit(c, actor, source.site_id, "github.candidate.review", {
        candidateId: candidate.id,
        status,
        version,
        fields: v.fields,
      });
      return { status, version };
    });
  }
  async saveResource(actor: Operator, input: unknown) {
    await this.operators.require(actor);
    const value = resourceInput.parse(input);
    return transaction(this.pool, (c) => this.writeResource(c, actor, value));
  }
  async resources(actor: Operator, query = "", page = 1) {
    await this.operators.require(actor);
    return (
      await this.pool.query(
        "SELECT id,version,data,public,internal_note FROM resource WHERE strpos(lower(id),lower($1))>0 ORDER BY id LIMIT 100 OFFSET $2",
        [
          z.string().max(200).parse(query),
          (z.coerce.number().int().min(1).max(100000).parse(page) - 1) * 100,
        ],
      )
    ).rows;
  }
  async exportResources(actor: Operator, query = "", page = 1) {
    const rows = await this.resources(actor, query, page);
    return {
      schemaVersion: 1,
      kind: "resources",
      resources: rows
        .filter((r) => r.data !== null)
        .map((r) => ({
          id: r.id,
          expectedVersion: r.version,
          data: r.data,
          public: r.public,
          internalNote: "",
        })),
    };
  }
  async importResources(actor: Operator, input: unknown, apply = false) {
    await this.operators.require(actor);
    const bundle = bundleSchema.parse(input);
    return transaction(this.pool, async (c) => {
      const results = [];
      for (const value of [...bundle.resources].sort((a, b) =>
        a.id.localeCompare(b.id),
      )) {
        const current = (
          await c.query(
            "SELECT version,internal_note FROM resource WHERE id=$1",
            [value.id],
          )
        ).rows[0];
        if ((current?.version ?? 0) !== value.expectedVersion)
          throw new Conflict("Resource version changed: " + value.id);
        // Public exchange files do not erase private notes on import.
        if (current) value.internalNote = current.internal_note;
        results.push({
          id: value.id,
          version: apply
            ? await this.writeResource(c, actor, value)
            : value.expectedVersion + 1,
        });
      }
      return { applied: apply, results };
    });
  }
  // Categories and tags are flat per-site taxonomies with the same shape and protocol.
  private async taxonomy(table: "category" | "tag", actor: Operator, site: string) {
    await this.operators.require(actor, site);
    return (
      await this.pool.query(
        `SELECT id,labels,rank,active,version FROM ${table} WHERE site_id=$1 ORDER BY rank,id`,
        [site],
      )
    ).rows;
  }
  private async saveTaxonomy(
    table: "category" | "tag",
    actor: Operator,
    site: string,
    input: unknown,
  ) {
    await this.operators.require(actor, site, true);
    const value = z
      .strictObject({
        id: identifier,
        labels: z
          .strictObject({ zh: text.optional(), en: text.optional() })
          .refine((v) => Object.keys(v).length > 0),
        rank: z.number().int().min(-100000).max(100000).default(0),
        active: z.boolean().default(true),
        expectedVersion: z.number().int().nonnegative(),
      })
      .parse(input);
    return transaction(this.pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        table + ":" + site + ":" + value.id,
      ]);
      await this.operators.require(actor, site, true, c);
      const row = (
        await c.query(
          `SELECT version FROM ${table} WHERE site_id=$1 AND id=$2`,
          [site, value.id],
        )
      ).rows[0];
      if ((row?.version ?? 0) !== value.expectedVersion)
        throw new Conflict(table === "tag" ? "Tag version changed" : "Category version changed");
      await c.query(
        `INSERT INTO ${table}(site_id,id,labels,rank,active,version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(site_id,id) DO UPDATE SET labels=$3,rank=$4,active=$5,version=$6`,
        [
          site,
          value.id,
          value.labels,
          value.rank,
          value.active,
          value.expectedVersion + 1,
        ],
      );
      await this.audit(c, actor, site, table + ".save", { id: value.id });
      return value.expectedVersion + 1;
    });
  }
  categories(actor: Operator, site: string) {
    return this.taxonomy("category", actor, site);
  }
  saveCategory(actor: Operator, site: string, input: unknown) {
    return this.saveTaxonomy("category", actor, site, input);
  }
  tags(actor: Operator, site: string) {
    return this.taxonomy("tag", actor, site);
  }
  saveTag(actor: Operator, site: string, input: unknown) {
    return this.saveTaxonomy("tag", actor, site, input);
  }
  async publications(actor: Operator, site: string, page = 1) {
    await this.operators.require(actor, site);
    return (
      await this.pool.query(
        `SELECT r.id,r.version AS resource_version,r.data,a.locale,p.slug,p.title,p.status,p.version,p.source_version,p.category_id,p.category_ids,p.tag_ids,p.rank,p.overrides,d.version AS draft_version,d.candidate
 FROM resource r JOIN (SELECT resource_id,locale FROM publication WHERE site_id=$1 UNION SELECT resource_id,locale FROM content_draft WHERE site_id=$1) a ON a.resource_id=r.id
 LEFT JOIN publication p ON p.resource_id=a.resource_id AND p.locale=a.locale AND p.site_id=$1 LEFT JOIN content_draft d ON d.resource_id=a.resource_id AND d.locale=a.locale AND d.site_id=$1 ORDER BY r.id,a.locale LIMIT 100 OFFSET $2`,
        [
          site,
          (z.coerce.number().int().min(1).max(100000).parse(page) - 1) * 100,
        ],
      )
    ).rows;
  }
  private async lock(
    c: PoolClient,
    site: string,
    resource: string,
    locale: string,
  ) {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "publication:" + site + ":" + resource + ":" + locale,
    ]);
  }
  private async material(
    c: PoolClient,
    site: string,
    resource: string,
    locale: string,
    candidate: z.infer<typeof candidateSchema>,
  ) {
    const row = (
      await c.query(
        "SELECT data FROM resource_revision WHERE resource_id=$1 AND version=$2",
        [resource, candidate.resourceVersion],
      )
    ).rows[0];
    if (!row) throw new HttpError(400, "资源版本不存在");
    const data = resourceData.parse(row.data);
    const translated = data.translations[locale as "zh" | "en"];
    if (!translated) throw new HttpError(400, "缺少已完成的该语言主档");
    // Primary category first, then the extra ones; duplicates collapse.
    const categoryIds = [
      ...new Set(
        [candidate.categoryId, ...(candidate.extraCategoryIds ?? [])].filter(
          (id): id is string => !!id,
        ),
      ),
    ];
    if (candidate.extraCategoryIds?.length && !candidate.categoryId)
      throw new HttpError(400, "设置其他分类前请先选择主分类");
    const tagIds = [...new Set(candidate.tagIds ?? [])];
    for (const [table, ids, message] of [
      ["category", categoryIds, "分类不属于本站"],
      ["tag", tagIds, "标签不属于本站"],
    ] as const)
      if (
        ids.length &&
        (
          await c.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE site_id=$1 AND id=ANY($2::text[])`,
            [site, ids],
          )
        ).rows[0].n !== ids.length
      )
        throw new HttpError(400, message);
    // Drafts follow the media's current version; publishing freezes that version.
    const frozen = async (
      ref: z.infer<typeof mediaRef> | null | undefined,
      message: string,
    ) => {
      if (!ref) return null;
      const media = (
        await c.query(
          // FOR SHARE: a concurrent replace waits, so the version frozen here
          // cannot become a deletable non-current version before this commits.
          "SELECT version FROM media WHERE site_id=$1 AND id=$2 FOR SHARE",
          [site, ref.mediaId],
        )
      ).rows[0];
      if (!media) throw new HttpError(400, message);
      return { ...ref, version: media.version as number };
    };
    const image = await frozen(candidate.overrides.image, "图片不属于本站");
    const logo = await frozen(candidate.overrides.logo, "logo 不属于本站");
    // Rich fields of this locale; the site may override tagline and content.
    const { title: _title, description: _description, ...rich } = translated;
    const details: Record<string, unknown> = {
      ...rich,
      tagline: candidate.overrides.tagline ?? rich.tagline,
      content: candidate.overrides.content ?? rich.content,
      pricing: data.pricing,
    };
    for (const key of Object.keys(details))
      if (details[key] === undefined || details[key] === "") delete details[key];
    return {
      slug: candidate.slug,
      title: candidate.overrides.title ?? translated.title,
      description: candidate.overrides.description ?? translated.description,
      url: candidate.overrides.url ?? data.url,
      seoTitle: candidate.overrides.seoTitle ?? "",
      seoDescription: candidate.overrides.seoDescription ?? "",
      image,
      logo,
      categoryId: candidate.categoryId,
      categoryIds,
      tagIds,
      details,
      rank: candidate.rank,
      sourceVersion: candidate.resourceVersion,
      overrides: candidate.overrides,
      module: data.kind === "repository" ? "opensource" : "directory",
      project: data.project ?? null,
    };
  }
  async mediaUsage(
    site: string,
    mediaId: string,
    executor: Pool | PoolClient = this.pool,
  ) {
    const { rows } = await executor.query(
      `SELECT EXISTS(SELECT 1 FROM public_listing WHERE site_id=$1 AND (image_media_id=$2::uuid OR logo_media_id=$2::uuid)) AS published,
              EXISTS(SELECT 1 FROM content_draft WHERE site_id=$1 AND $2::text IN(candidate->'overrides'->'image'->>'mediaId',candidate->'overrides'->'logo'->>'mediaId')) AS draft`,
      [site, mediaId],
    );
    return rows[0] as { published: boolean; draft: boolean };
  }
  // Versions currently served publicly on this site, highest first.
  async publishedMediaVersions(site: string, mediaId: string) {
    const { rows } = await this.pool.query(
      `SELECT image_version AS version FROM public_listing WHERE site_id=$1 AND image_media_id=$2::uuid
       UNION SELECT logo_version FROM public_listing WHERE site_id=$1 AND logo_media_id=$2::uuid ORDER BY version DESC`,
      [site, mediaId],
    );
    return rows.map((row) => Number(row.version));
  }
  // A version is pinned by any publication row (any status) so republish/unpublish
  // history never points at a deleted file.
  async mediaVersionPinned(
    site: string,
    mediaId: string,
    version: number,
    executor: Pool | PoolClient = this.pool,
  ) {
    const { rowCount } = await executor.query(
      `SELECT 1 FROM publication WHERE site_id=$1 AND (
         (image->>'mediaId'=$2 AND coalesce((image->>'version')::int,1)=$3) OR
         (logo->>'mediaId'=$2 AND (logo->>'version')::int=$3)) LIMIT 1`,
      [site, mediaId, version],
    );
    return Boolean(rowCount);
  }
  async stage(
    actor: Operator,
    site: string,
    resource: string,
    locale: string,
    input: unknown,
  ) {
    await this.operators.require(actor, site, true);
    identifier.parse(resource);
    localeSchema.parse(locale);
    const { candidate, expected } = z
      .strictObject({ candidate: candidateSchema, expected: expectedSchema })
      .parse(input);
    return transaction(this.pool, async (c) => {
      await this.lock(c, site, resource, locale);
      await this.operators.require(actor, site, true, c);
      const pub = (
        await c.query(
          "SELECT version FROM publication WHERE site_id=$1 AND resource_id=$2 AND locale=$3",
          [site, resource, locale],
        )
      ).rows[0];
      const draft = (
        await c.query(
          "SELECT version FROM content_draft WHERE site_id=$1 AND resource_id=$2 AND locale=$3",
          [site, resource, locale],
        )
      ).rows[0];
      if (!pub && !draft)
        await this.operators.require(actor, undefined, false, c); // Only network operators may distribute a new master to a site.
      await this.material(c, site, resource, locale, candidate);
      if (
        (pub?.version ?? 0) !== expected.published ||
        (draft?.version ?? 0) !== expected.draft
      )
        throw new Conflict("Publication version changed");
      await c.query(
        "INSERT INTO content_draft(site_id,resource_id,locale,candidate,version) VALUES($1,$2,$3,$4,$5) ON CONFLICT(site_id,resource_id,locale) DO UPDATE SET candidate=$4,version=$5",
        [site, resource, locale, candidate, expected.draft + 1],
      );
      await this.audit(c, actor, site, "publication.stage", {
        resource,
        locale,
      });
      return expected.draft + 1;
    });
  }
  async preview(
    actor: Operator,
    site: string,
    resource: string,
    locale: string,
  ) {
    await this.operators.require(actor, site);
    return transaction(
      this.pool,
      async (c) => {
        const row = (
          await c.query(
            "SELECT candidate FROM content_draft WHERE site_id=$1 AND resource_id=$2 AND locale=$3",
            [site, resource, locale],
          )
        ).rows[0];
        if (!row?.candidate) throw new HttpError(404, "没有草稿");
        return this.material(
          c,
          site,
          resource,
          locale,
          candidateSchema.parse(row.candidate),
        );
      },
      true,
    );
  }
  async publish(
    actor: Operator,
    site: string,
    resource: string,
    locale: string,
    input: unknown,
  ) {
    await this.operators.require(actor, site, true);
    const value = z
      .strictObject({ expected: expectedSchema, operationId: z.uuid() })
      .parse(input);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({ site, resource, locale, expected: value.expected }),
      )
      .digest("hex");
    return transaction(this.pool, async (c) => {
      await this.lock(c, site, resource, locale);
      await this.operators.require(actor, site, true, c);
      const previous = (
        await c.query("SELECT * FROM content_operation WHERE id=$1", [
          value.operationId,
        ])
      ).rows[0];
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new Conflict("Operation reused");
        return previous.version;
      }
      const pub = (
        await c.query(
          "SELECT version FROM publication WHERE site_id=$1 AND resource_id=$2 AND locale=$3",
          [site, resource, locale],
        )
      ).rows[0];
      const draft = (
        await c.query(
          "SELECT version,candidate FROM content_draft WHERE site_id=$1 AND resource_id=$2 AND locale=$3",
          [site, resource, locale],
        )
      ).rows[0];
      const expected = value.expected;
      if (
        (pub?.version ?? 0) !== expected.published ||
        (draft?.version ?? 0) !== expected.draft ||
        !draft?.candidate
      )
        throw new Conflict("Publication version changed or missing draft");
      const candidate = candidateSchema.parse(draft.candidate),
        snapshot = await this.material(c, site, resource, locale, candidate),
        version = expected.published + 1;
      await c.query(
        `INSERT INTO publication(site_id,resource_id,locale,slug,title,description,url,seo_title,seo_description,category_id,rank,version,source_version,overrides,module,project,image,category_ids,tag_ids,details,logo,first_published_at,published_at,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,now(),now(),'published') ON CONFLICT(site_id,resource_id,locale) DO UPDATE SET slug=$4,title=$5,description=$6,url=$7,seo_title=$8,seo_description=$9,category_id=$10,rank=$11,version=$12,source_version=$13,overrides=$14,module=$15,project=$16,image=$17,category_ids=$18,tag_ids=$19,details=$20,logo=$21,first_published_at=coalesce(publication.first_published_at,now()),published_at=now(),status='published'`,
        [
          site,
          resource,
          locale,
          snapshot.slug,
          snapshot.title,
          snapshot.description,
          snapshot.url,
          snapshot.seoTitle,
          snapshot.seoDescription,
          snapshot.categoryId,
          snapshot.rank,
          version,
          snapshot.sourceVersion,
          snapshot.overrides,
          snapshot.module,
          snapshot.project,
          snapshot.image,
          snapshot.categoryIds,
          snapshot.tagIds,
          snapshot.details,
          snapshot.logo,
        ],
      );
      await c.query("INSERT INTO publication_revision VALUES($1,$2,$3,$4,$5)", [
        site,
        resource,
        locale,
        version,
        snapshot,
      ]);
      await c.query(
        "UPDATE content_draft SET candidate=NULL,version=version+1 WHERE site_id=$1 AND resource_id=$2 AND locale=$3",
        [site, resource, locale],
      );
      await c.query("INSERT INTO content_operation VALUES($1,$2,$3)", [
        value.operationId,
        fingerprint,
        version,
      ]);
      await this.audit(c, actor, site, "publication.publish", {
        resource,
        locale,
        version,
      });
      return version;
    });
  }
  async unpublish(
    actor: Operator,
    site: string,
    resource: string,
    locale: string,
    expected: number,
  ) {
    await this.operators.require(actor, site, true);
    return transaction(this.pool, async (c) => {
      await this.lock(c, site, resource, locale);
      await this.operators.require(actor, site, true, c);
      const row = (
        await c.query(
          "UPDATE publication SET status='draft',version=version+1 WHERE site_id=$1 AND resource_id=$2 AND locale=$3 AND version=$4 RETURNING version",
          [site, resource, locale, expected],
        )
      ).rows[0];
      if (!row) throw new Conflict("Publication version changed");
      await this.audit(c, actor, site, "publication.unpublish", {
        resource,
        locale,
      });
      return row.version;
    });
  }
  async acceptCollected(
    actor: Operator,
    site: string,
    candidateId: string,
    expectedVersion: number,
  ) {
    await this.operators.require(actor, site, true);
    if (!z.uuid().safeParse(candidateId).success)
      throw new HttpError(404, "采集候选不存在");
    return transaction(this.pool, async (c) => {
      const candidate = (
        await c.query(
          `SELECT cc.* FROM collector_candidate cc JOIN collector_source cs ON cs.id=cc.source_id WHERE cc.id=$1 AND cs.site_id=$2 FOR UPDATE OF cc`,
          [candidateId, site],
        )
      ).rows[0];
      if (!candidate) throw new HttpError(404, "采集候选不存在");
      await this.operators.require(actor, site, true, c);
      if (candidate.status !== "pending" || candidate.version !== expectedVersion)
        throw new Conflict("采集候选已审核或版本已改变");
      const resource = "collector-" + candidate.id.replace(/-/g, "").slice(0, 32);
      await this.writeResource(
        c,
        actor,
        {
          id: resource,
          expectedVersion: 0,
          data: resourceData.parse(candidate.data),
          public: true,
          internalNote: "collector:" + candidate.source_id,
        },
        site,
      );
      await c.query(
        "INSERT INTO content_draft(site_id,resource_id,locale,candidate) VALUES($1,$2,$3,$4)",
        [
          site,
          resource,
          candidate.locale,
          candidateSchema.parse({
            resourceVersion: 1,
            slug: resource,
            categoryId: null,
            rank: 0,
            overrides: {},
          }),
        ],
      );
      await c.query(
        "UPDATE collector_candidate SET status='accepted',version=version+1,accepted_resource_id=$2,reviewed_at=now() WHERE id=$1",
        [candidateId, resource],
      );
      await this.audit(c, actor, site, "collector.accept", {
        candidateId,
        resource,
      });
      return { resourceId: resource };
    });
  }
  async submissions(actor: Operator, site: string, page = 1) {
    await this.operators.require(actor, site);
    return (
      await this.pool.query(
        "SELECT id,data,status,version,note,resource_id,created_at FROM submission WHERE site_id=$1 ORDER BY created_at DESC,id LIMIT 100 OFFSET $2",
        [
          site,
          (z.coerce.number().int().min(1).max(100000).parse(page) - 1) * 100,
        ],
      )
    ).rows;
  }
  async review(actor: Operator, site: string, id: string, input: unknown) {
    await this.operators.require(actor, site, true);
    z.uuid().parse(id);
    const value = z
      .strictObject({
        expectedVersion: z.number().int().positive(),
        decision: z.enum(["accepted", "rejected"]),
        note: z.string().max(500).default(""),
      })
      .parse(input);
    return transaction(this.pool, async (c) => {
      const row = (
        await c.query(
          "SELECT * FROM submission WHERE site_id=$1 AND id=$2 FOR UPDATE",
          [site, id],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "投稿不存在");
      await this.operators.require(actor, site, true, c);
      if (row.version !== value.expectedVersion || row.status !== "pending")
        throw new Conflict("Submission already reviewed");
      let resource: string | null = null;
      if (value.decision === "accepted") {
        resource = "submission-" + id;
        const data = resourceData.parse({
          url: row.data.url,
          translations: {
            [row.data.locale]: {
              title: row.data.title,
              description: row.data.description,
            },
          },
          source: "user-submission",
        });
        await this.writeResource(
          c,
          actor,
          {
            id: resource,
            expectedVersion: 0,
            data,
            public: true,
            internalNote: "",
          },
          site,
        );
        const candidate = candidateSchema.parse({
          resourceVersion: 1,
          slug: resource,
        });
        await c.query(
          "INSERT INTO content_draft(site_id,resource_id,locale,candidate) VALUES($1,$2,$3,$4)",
          [site, resource, row.data.locale, candidate],
        );
      }
      await c.query(
        "UPDATE submission SET status=$3,note=$4,resource_id=$5,version=version+1 WHERE site_id=$1 AND id=$2",
        [site, id, value.decision, value.note, resource],
      );
      await this.audit(c, actor, site, "submission.review", {
        id,
        decision: value.decision,
      });
      return { resourceId: resource };
    });
  }
  async updateDiff(actor: Operator, site: string, id: string, locale: string) {
    await this.operators.require(actor, site);
    return transaction(
      this.pool,
      async (c) => {
        const row = (
          await c.query(
            `SELECT p.*,r.version AS latest_version,d.candidate AS saved_candidate
 FROM resource r
 LEFT JOIN publication p ON p.resource_id=r.id AND p.site_id=$1 AND p.locale=$3
 LEFT JOIN content_draft d ON d.resource_id=r.id AND d.site_id=$1 AND d.locale=$3
 WHERE r.id=$2 AND (p.resource_id IS NOT NULL OR d.candidate IS NOT NULL)`,
            [site, id, locale],
          )
        ).rows[0];
        if (!row) throw new HttpError(404, "没有已分发的草稿或发布记录");
        if (row.latest_version === 0)
          throw new HttpError(400, "请先补录资源主档，再比较版本");
        // A saved draft is the operator's next publication. Adopting a new
        // master revision must preserve its site edits, including an empty
        // overrides object or a deliberately removed category.
        const candidate = candidateSchema.parse({
          ...(row.saved_candidate ?? publishedCandidate(row)),
          resourceVersion: row.latest_version,
        });
        const next = await this.material(c, site, id, locale, candidate);
        const before = {
          title: row.title,
          description: row.description,
          url: row.url,
          seoTitle: row.seo_title,
          seoDescription: row.seo_description,
          project: row.project ?? null,
          image: row.image ?? null,
          module: row.module,
          logo: row.logo ?? null,
          categoryIds: row.category_ids ?? [],
          tagIds: row.tag_ids ?? [],
          details: row.details ?? {},
        };
        const differences = (Object.keys(before) as (keyof typeof before)[])
          .filter((key) => !isDeepStrictEqual(before[key], next[key]))
          .map((field) => ({
            field,
            before: before[field],
            after: next[field],
          }));
        return {
          sourceVersion: row.source_version ?? 0,
          latestVersion: row.latest_version,
          candidate,
          differences,
        };
      },
      true,
    );
  }
  async resourceHistory(actor: Operator, id: string) {
    await this.operators.require(actor);
    return (
      await this.pool.query(
        "SELECT version,data FROM resource_revision WHERE resource_id=$1 ORDER BY version DESC LIMIT 100",
        [identifier.parse(id)],
      )
    ).rows;
  }
  async publicationHistory(
    actor: Operator,
    site: string,
    id: string,
    locale: string,
  ) {
    await this.operators.require(actor, site);
    return (
      await this.pool.query(
        "SELECT version,snapshot FROM publication_revision WHERE site_id=$1 AND resource_id=$2 AND locale=$3 ORDER BY version DESC LIMIT 100",
        [site, id, locale],
      )
    ).rows;
  }
  async diagnose(actor: Operator, site: string, id: string, locale: string) {
    await this.operators.require(actor, site);
    return transaction(
      this.pool,
      async (c) => {
        const s = (
          await c.query("SELECT active,modules,config FROM site WHERE id=$1", [
            site,
          ])
        ).rows[0];
        if (!s) throw new HttpError(404, "站点不存在");
        const row = (
          await c.query(
            "SELECT p.status,p.module,p.category_id,r.public,r.version,p.source_version FROM publication p JOIN resource r ON r.id=p.resource_id WHERE p.site_id=$1 AND p.resource_id=$2 AND p.locale=$3",
            [site, id, locale],
          )
        ).rows[0];
        const reasons = [];
        if (!row) reasons.push("not_published_in_locale");
        else {
          if (!s.active) reasons.push("site_disabled");
          if (!s.modules.includes(row.module)) reasons.push("module_disabled");
          if (!s.config.locales.includes(locale))
            reasons.push("locale_disabled");
          if (!row.public) reasons.push("resource_private");
          if (row.status !== "published")
            reasons.push("publication_unpublished");
          if (row.category_id) {
            const cat = (
              await c.query(
                "SELECT active,labels FROM category WHERE site_id=$1 AND id=$2",
                [site, row.category_id],
              )
            ).rows[0];
            if (!cat?.active || !cat.labels[locale])
              reasons.push("category_unavailable");
          }
        }
        const visible = !!(
          await c.query(
            "SELECT 1 FROM public_listing WHERE site_id=$1 AND resource_id=$2 AND locale=$3",
            [site, id, locale],
          )
        ).rowCount;
        if (!visible && reasons.length === 0)
          reasons.push("content_incomplete");
        return {
          visible,
          reasons,
          sourceUpdate: !!row && row.version > row.source_version,
        };
      },
      true,
    );
  }
}
export const submissionInput = z.strictObject({
  locale: localeSchema,
  url: webUrl,
  title: text,
  description,
});
