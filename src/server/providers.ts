import { z } from "zod";
import type { Pool } from "pg";
import { transaction } from "../domain/transaction.js";
import { seal, unseal } from "./crypto.js";
import { Operators, HttpError, type Operator } from "./operators.js";
import { assertPublicHost, publicUrl, requestText, UnsafePublicTarget } from "./outbound.js";
const inputSchema = z
  .strictObject({
    id: z.string().regex(/^(github|google|oidc-[a-z][a-z0-9-]{0,25})$/),
    kind: z.enum(["github", "google", "oidc"]),
    label: z.string().min(1).max(60),
    clientId: z.string().min(1).max(500),
    clientSecret: z.string().min(1).max(2000),
    issuer: z.url().optional(),
    authentication: z.enum(["basic", "post"]).default("post"),
    enabled: z.boolean().default(true),
  })
  .refine(
    (v) =>
      v.kind === "oidc"
        ? v.id.startsWith("oidc-") && !!v.issuer
        : v.id === v.kind,
    "Provider id/kind mismatch",
  );
export function oidcDiscovery(issuer: string) {
  return issuer.replace(/\/$/, "") + "/.well-known/openid-configuration";
}
export type ProviderConfig = z.infer<typeof inputSchema>;
function parseConfig(input: unknown) {
  const value = inputSchema.parse(input);
  if (value.issuer) {
    const url = new URL(value.issuer);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new HttpError(
        400,
        "OIDC issuer must be a fixed HTTPS URL without credentials, query or fragment",
      );
  }
  return value;
}
export class Providers {
  constructor(
    private pool: Pool,
    private key: string,
    private allowPrivate = false,
  ) {}
  async set(actor: Operator, site: string, input: unknown) {
    await new Operators(this.pool).require(actor);
    const value = parseConfig(input);
    // Better Auth fetches discovery, tokens and keys itself, so the issuer and every
    // endpoint it advertises are checked here; user info is pinned per sign-in in
    // auth.ts. A host that later re-points its DNS is not caught (see deploy docs).
    if (value.issuer && value.enabled && !this.allowPrivate)
      try {
        await assertPublicHost(new URL(value.issuer));
        // Discovery must answer directly (no redirect) and name only public
        // endpoints, since Better Auth calls the token and JWKS endpoints itself.
        const discovery = await requestText(
          publicUrl(oidcDiscovery(value.issuer)),
          { accept: "application/json" },
          5000,
          256 * 1024,
        );
        if (discovery.status !== 200) throw new Error("discovery");
        const metadata = z
          .object({
            issuer: z.literal(value.issuer),
            authorization_endpoint: z.url(),
            token_endpoint: z.url(),
            jwks_uri: z.url(),
            userinfo_endpoint: z.url().optional(),
          })
          .parse(JSON.parse(discovery.text));
        for (const endpoint of [
          metadata.authorization_endpoint,
          metadata.token_endpoint,
          metadata.jwks_uri,
          ...(metadata.userinfo_endpoint ? [metadata.userinfo_endpoint] : []),
        ])
          await assertPublicHost(new URL(endpoint));
      } catch (error) {
        throw new HttpError(
          400,
          error instanceof UnsafePublicTarget
            ? "OIDC issuer 及其端点必须是公开网络上的 HTTPS 地址"
            : "无法读取或校验 OIDC issuer 的 discovery 文档",
        );
      }
    return transaction(this.pool, async (c) => {
      const instance = (
        await c.query(
          "SELECT id,center_site FROM auth_instance WHERE site_id=$1 FOR UPDATE",
          [site],
        )
      ).rows[0];
      await new Operators(this.pool).require(actor, undefined, false, c);
      if (!instance || instance.center_site)
        throw new HttpError(400, "请配置独立账号中心的登录提供方");
      await c.query(
        "INSERT INTO auth_provider VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(instance_id,id) DO UPDATE SET kind=$3,label=$4,sealed_config=$5,enabled=$6",
        [
          instance.id,
          value.id,
          value.kind,
          value.label,
          seal(value, this.key),
          value.enabled,
        ],
      );
      await c.query(
        "UPDATE auth_instance SET provider_revision=provider_revision+1 WHERE id=$1",
        [instance.id],
      );
      await c.query(
        "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,'auth.provider.set',$3)",
        [actor.id, site, { id: value.id, enabled: value.enabled }],
      );
      return { id: value.id, enabled: value.enabled };
    });
  }
  async inspect(actor: Operator, site: string, input: unknown) {
    await new Operators(this.pool).require(actor);
    const value = parseConfig(input);
    const instance = (
      await this.pool.query(
        "SELECT id,origin,center_site FROM auth_instance WHERE site_id=$1",
        [site],
      )
    ).rows[0];
    if (!instance || instance.center_site)
      throw new HttpError(400, "请配置独立账号中心的登录提供方");
    const existing =
      (
        await this.pool.query(
          "SELECT label,enabled FROM auth_provider WHERE instance_id=$1 AND id=$2",
          [instance.id, value.id],
        )
      ).rows[0] ?? null;
    return {
      site,
      id: value.id,
      kind: value.kind,
      label: value.label,
      callbackUrl: instance.origin + "/api/auth/callback/" + value.id,
      existing: existing
        ? { label: existing.label, enabled: existing.enabled }
        : null,
    };
  }
  async list(actor: Operator, site: string) {
    const instance = (
      await this.pool.query(
        "SELECT id,origin FROM auth_instance WHERE site_id=$1",
        [site],
      )
    ).rows[0];
    if (!instance) throw new HttpError(404, "认证实例不存在");
    // Read-only provider status is visible to site viewers; secrets are not.
    await new Operators(this.pool).require(actor, site);
    return {
      site,
      origin: instance.origin,
      providers: (
        await this.pool.query(
          "SELECT id,kind,label,enabled FROM auth_provider WHERE instance_id=$1 ORDER BY id",
          [instance.id],
        )
      ).rows.map((provider) => ({
        ...provider,
        callbackUrl:
          instance.origin + "/api/auth/callback/" + provider.id,
      })),
    };
  }
  async get(instanceId: string) {
    const rows = (
      await this.pool.query(
        "SELECT id,sealed_config FROM auth_provider WHERE instance_id=$1 AND enabled ORDER BY id",
        [instanceId],
      )
    ).rows;
    const providers = [];
    for (const row of rows) {
      try {
        providers.push(
          inputSchema.parse(unseal(row.sealed_config, this.key)),
        );
      } catch {
        // One damaged/rotated provider must not hide the remaining options.
        console.error("Ignoring unreadable auth provider configuration", {
          instanceId,
          providerId: row.id,
        });
      }
    }
    return providers;
  }
}
