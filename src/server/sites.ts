import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "../domain/transaction.js";
import { ConfigStore, configSchema, snapshotSchema } from "../domain/config.js";
import { Operators, HttpError, type Operator } from "./operators.js";
import { seal } from "./crypto.js";
import { templateIds } from "./templates.js";
const siteInput = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  name: z.string().min(1).max(100),
  origin: z.url(),
  centerSite: z.string().nullable().default(null),
});
export class Sites {
  readonly operators: Operators;
  constructor(
    private pool: Pool,
    private key: string,
    private adminOrigin: string,
    private insecure = false,
  ) {
    this.operators = new Operators(pool);
  }
  config(user: Operator) {
    return new ConfigStore(this.pool, templateIds, {
      actorId: user.id,
      authorize: async (c, site) => {
        await this.operators.require(user, site, true, c);
      },
    });
  }
  async create(actor: Operator, input: unknown) {
    await this.operators.require(actor);
    const value = siteInput.parse(input);
    const origin = new URL(value.origin);
    if (
      origin.origin !== value.origin ||
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      (!this.insecure && origin.protocol !== "https:")
    )
      throw new HttpError(400, "请填写完整 HTTPS 站点源地址");
    if (
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(origin.hostname) ||
      origin.hostname === new URL(this.adminOrigin).hostname
    )
      throw new HttpError(400, "域名不合法或与后台冲突");
    const config = configSchema.parse({
      name: value.name,
      template: "basic",
      locales: ["zh"],
      tagline: "从这里开始，发现值得收藏的网站。",
    });
    const secret = seal(
      {
        secret: randomBytes(32).toString("hex"),
        bootstrap: randomBytes(32).toString("hex"),
        clientSecret: randomBytes(32).toString("hex"),
      },
      this.key,
    );
    return transaction(this.pool, async (c) => {
      let space = value.id;
      if (value.centerSite) {
        if (origin.protocol !== "https:")
          throw new HttpError(400, "共享账号必须使用 HTTPS");
        const center = (
          await c.query(
            `SELECT i.space_id,a.center_site,a.origin FROM identity_site i JOIN auth_instance a ON a.site_id=i.site_id WHERE i.site_id=$1 FOR SHARE OF a`,
            [value.centerSite],
          )
        ).rows[0];
        if (
          !center ||
          center.center_site ||
          !center.origin.startsWith("https:")
        )
          throw new HttpError(400, "请选择独立账号中心");
        space = center.space_id;
      }
      await this.operators.require(actor, undefined, false, c);
      await c.query("INSERT INTO site(id,host,config) VALUES($1,$2,$3)", [
        value.id,
        origin.hostname,
        config,
      ]);
      await c.query("INSERT INTO config_revision VALUES($1,0,$2)", [
        value.id,
        config,
      ]);
      if (!value.centerSite)
        await c.query("INSERT INTO identity_space VALUES($1,$2)", [
          space,
          value.id,
        ]);
      await c.query("INSERT INTO identity_site VALUES($1,$2)", [
        value.id,
        space,
      ]);
      await c.query(
        "INSERT INTO auth_instance(site_id,origin,center_site,sealed_secret) VALUES($1,$2,$3,$4)",
        [value.id, value.origin, value.centerSite, secret],
      );
      await c.query(
        "INSERT INTO audit_event(actor_id,site_id,action) VALUES($1,$2,'site.create')",
        [actor.id, value.id],
      );
      return { id: value.id, state: "pending" };
    });
  }
  async list(actor: Operator) {
    return (
      await this.pool.query(
        `SELECT s.id,s.host,s.active,s.revision,s.draft_version,s.config,a.origin,a.center_site,a.state,a.error_code
  FROM site s JOIN auth_instance a ON a.site_id=s.id JOIN operator_user u ON u.id=$1 AND NOT u.disabled
  WHERE u.global_admin OR EXISTS(SELECT 1 FROM operator_grant g WHERE g.user_id=u.id AND g.site_id=s.id) ORDER BY s.id`,
        [actor.id],
      )
    ).rows;
  }
  async status(actor: Operator, siteId: string, active: boolean) {
    await this.operators.require(actor, siteId, true);
    return transaction(this.pool, async (c) => {
      const site = await c.query("SELECT id FROM site WHERE id=$1 FOR UPDATE", [
        siteId,
      ]);
      if (!site.rowCount) throw new HttpError(404, "站点不存在");
      await this.operators.require(actor, siteId, true, c);
      await c.query("UPDATE site SET active=$2 WHERE id=$1", [siteId, active]);
      await c.query(
        "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,'site.status',$3)",
        [actor.id, siteId, { active }],
      );
    });
  }
  async export(actor: Operator, siteId: string, draft = false) {
    await this.operators.require(actor, siteId);
    const row = await this.config(actor).read(siteId);
    return {
      schemaVersion: 1,
      kind: draft ? "draft" : "published",
      siteId,
      baseRevision: row.revision,
      ...(draft ? { sourceDraftVersion: row.draft_version } : {}),
      config: draft ? (row.draft ?? row.config) : row.config,
    };
  }
  parseFile(input: unknown) {
    const envelope = snapshotSchema
      .extend({
        kind: z.enum(["published", "draft"]),
        sourceDraftVersion: z.number().int().nonnegative().optional(),
      })
      .parse(input);
    const { kind, sourceDraftVersion, ...snapshot } = envelope;
    return snapshot;
  }
  async preview(actor: Operator, siteId: string, input: unknown) {
    await this.operators.require(actor, siteId);
    return this.config(actor).preview(siteId, this.parseFile(input));
  }
  async save(
    actor: Operator,
    siteId: string,
    input: unknown,
    expected: { revision: number; draftVersion: number },
    replace = false,
  ) {
    return this.config(actor).save(
      siteId,
      this.parseFile(input),
      expected,
      replace,
    );
  }
  async publish(
    actor: Operator,
    siteId: string,
    expected: { revision: number; draftVersion: number },
    operationId: string = randomUUID(),
  ) {
    return this.config(actor).publish(siteId, expected, operationId);
  }
}
