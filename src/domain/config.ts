import { moduleIds } from "../public/modules.js";
import { transaction } from "./transaction.js";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

export const templateParamsSchema = z.strictObject({
  accent: z.enum(["forest", "indigo", "terracotta"]).optional(),
  density: z.enum(["comfortable", "compact"]).optional(),
  eyebrow: z.string().max(100).optional(),
  footer: z.string().max(300).optional(),
  // Brand color for templates that derive their palette from one hue (toolso).
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  motion: z.enum(["smooth", "crisp", "playful", "minimal"]).optional(),
});
const item = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  label: z.string().min(1).max(100),
  href: z.string().regex(/^\/(?!\/)[a-zA-Z0-9/_-]*$/),
});
export const configSchema = z.strictObject({
  name: z.string().min(1).max(100),
  catalogPath: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,30}$/)
    .default("tools"),
  template: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  templateParams: templateParamsSchema.default({}),
  locales: z
    .array(z.enum(["en", "zh"]))
    .min(1)
    .max(2)
    .refine((v) => new Set(v).size === v.length),
  navigation: z
    .array(item)
    .max(50)
    .default([])
    .refine((v) => new Set(v.map((i) => i.id)).size === v.length),
  tagline: z.string().max(300).default(""),
  modules: z
    .array(z.enum(moduleIds))
    .max(2)
    .default(["directory"])
    .refine(
      (v) =>
        new Set(v).size === v.length &&
        (!v.includes("opensource") || v.includes("directory")),
      "Open-source module requires directory",
    ),
});
export const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  siteId: z.string().min(1),
  baseRevision: z.number().int().nonnegative(),
  config: configSchema,
});
export type Config = z.infer<typeof configSchema>;
export class Conflict extends Error {}
export class InvalidReference extends Error {}
export type Version = { revision: number; draftVersion: number };

export class ConfigStore {
  constructor(
    private readonly pool: Pool,
    private readonly templates: ReadonlySet<string>,
    private readonly access?: {
      actorId: string;
      authorize: (client: PoolClient, siteId: string) => Promise<void>;
    },
  ) {}
  private validate(config: unknown): Config {
    const parsed = configSchema.parse(config);
    if (!this.templates.has(parsed.template))
      throw new InvalidReference("Template unavailable");
    return parsed;
  }
  private async locked<T>(
    siteId: string,
    fn: (
      client: PoolClient,
      row: {
        revision: number;
        draft_version: number;
        draft: Config | null;
        config: Config;
      },
    ) => Promise<T>,
    action = "config.save",
  ): Promise<T> {
    return transaction(this.pool, async (c) => {
      const { rows } = await c.query(
        "SELECT * FROM site WHERE id=$1 FOR UPDATE",
        [siteId],
      );
      if (!rows.length) throw new InvalidReference("Unknown site");
      await this.access?.authorize(c, siteId);
      const result = await fn(c, rows[0]);
      if (this.access)
        await c.query(
          "INSERT INTO audit_event(actor_id,site_id,action) VALUES($1,$2,$3)",
          [this.access.actorId, siteId, action],
        );
      return result;
    });
  }
  async read(siteId: string) {
    const { rows } = await this.pool.query(
      "SELECT revision, draft_version, draft, config FROM site WHERE id=$1",
      [siteId],
    );
    if (!rows.length) throw new InvalidReference("Unknown site");
    return rows[0] as {
      revision: number;
      draft_version: number;
      draft: Config | null;
      config: Config;
    };
  }
  async preview(siteId: string, input: unknown) {
    const snapshot = snapshotSchema.parse(input);
    if (snapshot.siteId !== siteId) throw new Conflict("Wrong target");
    const candidate = this.validate(snapshot.config);
    const current = await this.read(siteId);
    const before = current.draft ?? current.config;
    const differences = (Object.keys(candidate) as (keyof Config)[])
      .filter((key) => !isDeepStrictEqual(before[key], candidate[key]))
      .map((key) => ({
        field: key,
        before: before[key],
        after: candidate[key],
      }));
    return {
      revision: current.revision,
      draftVersion: current.draft_version,
      stale: snapshot.baseRevision !== current.revision,
      replacesDraft: current.draft !== null,
      differences,
    };
  }
  async save(
    siteId: string,
    input: unknown,
    expected: Version,
    replaceDraft = false,
  ) {
    const snapshot = snapshotSchema.parse(input);
    if (
      snapshot.siteId !== siteId ||
      snapshot.baseRevision !== expected.revision
    )
      throw new Conflict("Snapshot target/version mismatch");
    const config = this.validate(snapshot.config);
    return this.locked(siteId, async (c, row) => {
      if (
        row.revision !== expected.revision ||
        row.draft_version !== expected.draftVersion
      )
        throw new Conflict("Stale version");
      if (row.draft && !replaceDraft)
        throw new Conflict("Explicit draft replacement required");
      if (isDeepStrictEqual(row.draft, config))
        return row.draft_version as number;
      await c.query(
        "UPDATE site SET draft=$2, draft_version=draft_version+1 WHERE id=$1",
        [siteId, config],
      );
      return (row.draft_version + 1) as number;
    });
  }
  async publish(siteId: string, expected: Version, operationId: string) {
    z.uuid().parse(operationId);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ siteId, expected }))
      .digest("hex");
    return this.locked(
      siteId,
      async (c, row) => {
        const previous = await c.query(
          "SELECT * FROM config_operation WHERE id=$1",
          [operationId],
        );
        if (previous.rows.length) {
          if (previous.rows[0].fingerprint !== fingerprint)
            throw new Conflict("Operation reused with different arguments");
          return previous.rows[0].revision as number;
        }
        if (
          row.revision !== expected.revision ||
          row.draft_version !== expected.draftVersion ||
          !row.draft
        )
          throw new Conflict("Stale or missing draft");
        const config = this.validate(row.draft);
        const revision = row.revision + 1;
        await c.query("INSERT INTO config_revision VALUES ($1,$2,$3)", [
          siteId,
          revision,
          config,
        ]);
        await c.query(
          "UPDATE site SET revision=$2, config=$3, modules=$4, draft=NULL, draft_version=draft_version+1 WHERE id=$1",
          [siteId, revision, config, config.modules],
        );
        await c.query("INSERT INTO outbox(site_id,revision) VALUES($1,$2)", [
          siteId,
          revision,
        ]);
        await c.query("INSERT INTO config_operation VALUES($1,$2,$3,$4)", [
          operationId,
          siteId,
          fingerprint,
          revision,
        ]);
        return revision;
      },
      "config.publish",
    );
  }
  async rollback(siteId: string, revision: number, expected: Version) {
    const result = await this.pool.query(
      "SELECT config FROM config_revision WHERE site_id=$1 AND revision=$2",
      [siteId, revision],
    );
    if (!result.rows.length) throw new InvalidReference("Unknown revision");
    return this.save(
      siteId,
      {
        schemaVersion: 1,
        siteId,
        baseRevision: expected.revision,
        config: result.rows[0].config,
      },
      expected,
      true,
    );
  }
}
