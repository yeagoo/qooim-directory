import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { jwt, genericOAuth } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { z } from "zod";
import { IdentityStore } from "../domain/identity.js";
import { transaction } from "../domain/transaction.js";
import { unseal } from "./crypto.js";
import {
  AuthLimiter,
  authPolicy,
  clientIp,
  type AuthPolicy,
} from "./auth-policy.js";
import { MailQueue } from "./mail.js";
import { Providers, oidcDiscovery } from "./providers.js";
import { HttpError } from "./operators.js";
export type AuthInstance = {
  id: string;
  site_id: string;
  origin: string;
  center_site: string | null;
  sealed_secret: string;
  state: string;
  attempts: number;
  provider_revision: number;
};
type Secrets = { secret: string; bootstrap: string; clientSecret: string };
type Context = {
  bootstrap?: boolean;
  client?: { id: string; secret: string };
  identity?: { subject: string; session: string; email: string };
  lock?: PoolClient;
};
type Runtime = {
  handler: (request: Request) => Promise<Response>;
  session: (headers: Headers) => Promise<{
    user: { id: string; email: string };
    session: { id: string };
  } | null>;
  createClient: (child: AuthInstance) => Promise<void>;
};
export function prefix(instance: AuthInstance) {
  if (!/^\d+$/.test(instance.id))
    throw new Error("Invalid instance identifier");
  return "network_" + instance.id + "_";
}
export class AuthRegistry {
  readonly mail: MailQueue;
  readonly providers: Providers;
  readonly limiter: AuthLimiter;
  private context = new AsyncLocalStorage<Context>();
  private cache = new Map<string, Promise<Runtime>>();
  private locks: Pool;
  private identities: IdentityStore;
  constructor(
    private pool: Pool,
    private key: string,
    connectionString: string,
    readonly policy: AuthPolicy = authPolicy(),
  ) {
    this.mail = new MailQueue(pool, key, policy.smtp);
    this.providers = new Providers(pool, key);
    this.limiter = new AuthLimiter(pool);
    this.identities = new IdentityStore(pool);
    this.locks = new Pool({
      connectionString,
      // Each in-flight social callback and provision can hold one advisory
      // lock across provider I/O; two connections serialized normal traffic.
      max: 8,
      connectionTimeoutMillis: 5000,
      query_timeout: 20000,
    });
    this.locks.on("error", () =>
      console.error("Authentication lock unavailable"),
    );
    this.locks.on("connect", (c) =>
      c.on("error", () => console.error("Authentication lock interrupted")),
    );
  }
  async close() {
    await this.locks.end();
  }
  async instance(site: string) {
    const row = (
      await this.pool.query<AuthInstance>(
        "SELECT * FROM auth_instance WHERE site_id=$1",
        [site],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "认证实例不存在");
    return row;
  }
  private async options(instance: AuthInstance) {
    const table = prefix(instance),
      secret = unseal<Secrets>(instance.sealed_secret, this.key);
    const center = instance.center_site
      ? await this.instance(instance.center_site)
      : null;
    const serviceEmail = `service-${instance.id}@bootstrap.invalid`;
    const context = this.context;
    const providers = center ? [] : await this.providers.get(instance.id);
    const socialProviders = Object.fromEntries(
      providers
        .filter((p) => p.kind !== "oidc")
        .map((p) => [
          p.kind,
          { clientId: p.clientId, clientSecret: p.clientSecret },
        ]),
    );
    const external = providers
      .filter((p) => p.kind === "oidc")
      .map((provider) => ({
        providerId: provider.id,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        discoveryUrl: oidcDiscovery(provider.issuer!),
        authentication: provider.authentication,
        scopes: ["openid", "profile", "email"],
        pkce: true,
        requireIdTokenVerification: true,
        getUserInfo: async (tokens: {
          idToken?: string;
          accessToken?: string;
        }) => {
          if (!tokens.idToken) throw new Error("Missing verified ID token");
          const claims = z
            .object({
              iss: z.literal(provider.issuer!),
              sub: z.string().min(1),
            })
            .parse(
              JSON.parse(
                Buffer.from(
                  tokens.idToken.split(".")[1],
                  "base64url",
                ).toString(),
              ),
            );
          const discovery = await fetch(oidcDiscovery(provider.issuer!), {
            redirect: "error",
            signal: AbortSignal.timeout(5000),
          });
          if (!discovery.ok) throw new Error("Discovery unavailable");
          const metadata = z
            .object({
              issuer: z.literal(provider.issuer!),
              userinfo_endpoint: z.url(),
            })
            .parse(await discovery.json());
          const endpoint = new URL(metadata.userinfo_endpoint);
          if (endpoint.protocol !== "https:") throw new Error("HTTPS required");
          const response = await fetch(endpoint, {
            headers: { authorization: "Bearer " + tokens.accessToken },
            redirect: "error",
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) throw new Error("User info unavailable");
          const profile = z
            .object({
              sub: z.literal(claims.sub),
              email: z.email(),
              email_verified: z.literal(true),
              name: z.string().optional(),
            })
            .parse(await response.json());
          const state = context.getStore();
          if (!state) throw new Error("Missing request context");
          state.lock = await this.locks.connect();
          await state.lock.query("BEGIN");
          await state.lock.query("SET LOCAL lock_timeout='5s'");
          await state.lock.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [instance.id + ":" + provider.id + ":" + claims.sub],
          );
          return {
            id: claims.sub,
            sub: claims.sub,
            email: profile.email,
            name: profile.name ?? profile.email.split("@")[0],
            emailVerified: true,
          };
        },
      }));

    return {
      database: this.pool,
      baseURL: instance.origin,
      secret: secret.secret,
      trustedOrigins: [instance.origin],
      user: { modelName: table + "user" },
      session: {
        modelName: table + "session",
        cookieCache: { enabled: false },
        expiresIn: this.policy.sessionSeconds,
        updateAge: this.policy.updateSeconds,
      },
      account: {
        modelName: table + "account",
        accountLinking: { enabled: true, disableImplicitLinking: true },
      },
      verification: { modelName: table + "verification" },
      socialProviders,
      emailAndPassword: {
        enabled: !center,
        minPasswordLength: 12,
        maxPasswordLength: 128,
        requireEmailVerification: this.policy.requireEmail,
        revokeSessionsOnPasswordReset: true,
        ...(this.policy.smtp
          ? {
              sendResetPassword: async ({
                user,
                url,
              }: {
                user: { email: string };
                url: string;
              }) =>
                this.mail.enqueue(
                  instance.site_id,
                  instance.origin,
                  "reset",
                  user.email,
                  url,
                ),
            }
          : {}),
        onPasswordReset: async ({ user }: { user: { id: string } }) => {
          await this.pool.query(
            `UPDATE identity_session target SET revoked=true FROM session_bridge b,identity_session source WHERE b.instance_id=$1 AND b.local_user=$2 AND source.id=b.canonical_session AND target.user_id=source.user_id AND target.space_id=source.space_id`,
            [instance.id, user.id],
          );
        },
      },
      emailVerification: {
        sendOnSignUp: !!this.policy.smtp,
        sendOnSignIn: !!this.policy.smtp,
        autoSignInAfterVerification: false,
        expiresIn: 3600,
        ...(this.policy.smtp
          ? {
              sendVerificationEmail: async ({
                user,
                url,
              }: {
                user: { email: string };
                url: string;
              }) =>
                this.mail.enqueue(
                  instance.site_id,
                  instance.origin,
                  "verify",
                  user.email,
                  url,
                ),
            }
          : {}),
      },
      rateLimit: { enabled: false },
      advanced: { useSecureCookies: instance.origin.startsWith("https:") },
      logger: { disabled: true },
      databaseHooks: {
        user: {
          create: {
            before: async (user: { email: string }) => {
              if (
                user.email.endsWith("@bootstrap.invalid") &&
                !context.getStore()?.bootstrap
              )
                throw new Error("Reserved identity");
            },
          },
        },
        session: {
          create: {
            after: async (session: {
              id: string;
              userId: string;
              expiresAt: Date;
            }) => {
              let identity = context.getStore()?.identity;
              if (!center) {
                const user = (
                  await this.pool.query(
                    `SELECT email FROM ${table}user WHERE id=$1`,
                    [session.userId],
                  )
                ).rows[0];
                identity = {
                  subject: session.userId,
                  session: session.id,
                  email: user.email,
                };
              }
              if (!identity) throw new Error("Verified identity required");
              const canonical = await this.identities.provisionVerifiedSubject({
                siteId: instance.site_id,
                issuer: (center ?? instance).origin + "/api/auth",
                subject: identity.subject,
                email: identity.email,
              });
              await this.pool.query(
                `WITH created AS (INSERT INTO identity_session(site_id,space_id,user_id,center_session,expires_at,absolute_expires_at) VALUES($1,$2,$3,$4,LEAST($5,now()+$9::int*interval '1 second'),now()+$9::int*interval '1 second') RETURNING id)
     INSERT INTO session_bridge(instance_id,local_session,local_user,canonical_session) SELECT $6,$7,$8,id FROM created`,
                [
                  instance.site_id,
                  canonical.spaceId,
                  canonical.userId,
                  identity.session,
                  session.expiresAt,
                  instance.id,
                  session.id,
                  session.userId,
                  this.policy.absoluteSeconds,
                ],
              );
            },
          },
          update: {
            after: async (session: { id: string; expiresAt: Date }) => {
              await this.pool.query(
                `UPDATE identity_session ss SET expires_at=LEAST($3,ss.absolute_expires_at) FROM session_bridge b WHERE b.instance_id=$1 AND b.local_session=$2 AND ss.id=b.canonical_session AND NOT ss.revoked AND ss.expires_at>now() AND ss.absolute_expires_at>now()`,
                [instance.id, session.id, session.expiresAt],
              );
            },
          },
          delete: {
            before: async (session: { id: string }) => {
              await this.pool.query(
                `UPDATE identity_session target SET revoked=true FROM session_bridge b,identity_session source
     WHERE b.instance_id=$1 AND b.local_session=$2 AND source.id=b.canonical_session
      AND (target.id=source.id OR ($3 AND target.space_id=source.space_id AND target.user_id=source.user_id AND target.center_session=source.center_session))`,
                [instance.id, session.id, !center],
              );
            },
          },
        },
      },
      plugins: center
        ? [
            genericOAuth({
              config: [
                {
                  providerId: "network",
                  clientId: "site_" + instance.id,
                  clientSecret: secret.clientSecret,
                  discoveryUrl:
                    center.origin +
                    "/api/auth/.well-known/openid-configuration",
                  requireIdTokenVerification: true,
                  pkce: true,
                  disableProviderLogout: true,
                  scopes: ["openid", "profile", "email"],
                  getUserInfo: async (tokens) => {
                    if (!tokens.idToken)
                      throw new Error("Missing verified ID token");
                    const claims = z
                      .object({
                        iss: z.literal(center.origin + "/api/auth"),
                        sub: z.string().min(1),
                        sid: z.string().min(1),
                      })
                      .parse(
                        JSON.parse(
                          Buffer.from(
                            tokens.idToken.split(".")[1],
                            "base64url",
                          ).toString(),
                        ),
                      );
                    const response = await fetch(
                      center.origin + "/api/auth/oauth2/userinfo",
                      {
                        headers: {
                          authorization: "Bearer " + tokens.accessToken,
                        },
                        redirect: "error",
                        signal: AbortSignal.timeout(5000),
                      },
                    );
                    if (!response.ok)
                      throw new Error("Account center unavailable");
                    const profile = z
                      .object({
                        sub: z.literal(claims.sub),
                        email: z.email(),
                        name: z.string(),
                        email_verified: z.boolean().optional(),
                      })
                      .parse(await response.json());
                    const state = context.getStore();
                    if (!state) throw new Error("Missing request context");
                    state.identity = {
                      subject: claims.sub,
                      session: claims.sid,
                      email: profile.email,
                    };
                    state.lock = await this.locks.connect();
                    await state.lock.query("BEGIN");
                    await state.lock.query("SET LOCAL lock_timeout='5s'");
                    await state.lock.query(
                      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
                      [instance.id + ":" + claims.sub],
                    );
                    return {
                      id: claims.sub,
                      sub: claims.sub,
                      email: profile.email,
                      name: profile.name,
                      emailVerified: profile.email_verified ?? false,
                    };
                  },
                },
              ],
            }),
          ]
        : [
            jwt({ schema: { jwks: { modelName: table + "jwks" } } }),
            oauthProvider({
              loginPage: "/login",
              consentPage: "/login",
              grantTypes: ["authorization_code"],
              scopes: ["openid", "profile", "email"],
              clientPrivileges: ({ user }) => user?.email === serviceEmail,
              generateClientId: () =>
                context.getStore()?.client?.id ?? randomUUID(),
              generateClientSecret: () =>
                context.getStore()?.client?.secret ??
                randomBytes(32).toString("hex"),
              schema: {
                oauthClient: { modelName: table + "oauth_client" },
                oauthResource: { modelName: table + "oauth_resource" },
                oauthClientResource: {
                  modelName: table + "oauth_client_resource",
                },
                oauthRefreshToken: { modelName: table + "oauth_refresh_token" },
                oauthAccessToken: { modelName: table + "oauth_access_token" },
                oauthConsent: { modelName: table + "oauth_consent" },
                oauthClientAssertion: {
                  modelName: table + "oauth_client_assertion",
                },
              },
            }),
            ...(external.length ? [genericOAuth({ config: external })] : []),
          ],
    };
  }
  private async instantiate(instance: AuthInstance): Promise<Runtime> {
    const options = await this.options(instance);
    const auth = betterAuth(options);
    return {
      handler: (request) => auth.handler(request),
      session: (headers) =>
        auth.api.getSession({ headers, query: { disableRefresh: true } }),
      createClient: async (child) => {
        const table = prefix(instance),
          childSecret = unseal<Secrets>(child.sealed_secret, this.key);
        if (
          (
            await this.pool.query(
              `SELECT 1 FROM ${table}oauth_client WHERE "clientId"=$1`,
              ["site_" + child.id],
            )
          ).rowCount
        )
          return;
        const secret = unseal<Secrets>(instance.sealed_secret, this.key),
          email = `service-${instance.id}@bootstrap.invalid`;
        await this.context.run(
          {
            bootstrap: true,
            client: {
              id: "site_" + child.id,
              secret: childSecret.clientSecret,
            },
          },
          async () => {
            const exists = (
              await this.pool.query(
                `SELECT 1 FROM ${table}user WHERE email=$1`,
                [email],
              )
            ).rowCount;
            if (!exists) {
              const signup = await auth.api.signUpEmail({
                body: {
                  email,
                  password: secret.bootstrap,
                  name: "Provisioning service",
                },
                asResponse: true,
              });
              if (!signup.ok)
                throw new Error("Account center bootstrap failed");
              await this.pool.query(
                `UPDATE ${table}user SET "emailVerified"=true WHERE email=$1`,
                [email],
              );
            }
            const response = await auth.api.signInEmail({
              body: { email, password: secret.bootstrap },
              asResponse: true,
            });
            if (!response.ok)
              throw new Error("Account center bootstrap failed");
            const headers = new Headers({
              cookie: response.headers
                .getSetCookie()
                .map((v) => v.split(";")[0])
                .join("; "),
            });
            try {
              await auth.api.adminCreateOAuthClient({
                headers,
                body: {
                  redirect_uris: [child.origin + "/api/auth/callback/network"],
                  skip_consent: true,
                  enable_end_session: true,
                  require_pkce: true,
                  scope: "openid profile email",
                  grant_types: ["authorization_code"],
                  token_endpoint_auth_method: "client_secret_post",
                },
              });
            } finally {
              await auth.api.signOut({ headers });
            }
          },
        );
      },
    };
  }
  private runtime(instance: AuthInstance) {
    const cacheKey = instance.id + ":" + instance.provider_revision;
    let runtime = this.cache.get(cacheKey);
    if (!runtime) {
      runtime = this.instantiate(instance);
      this.cache.set(cacheKey, runtime);
      runtime.catch(() => this.cache.delete(cacheKey));
      if (this.cache.size > 64)
        this.cache.delete(this.cache.keys().next().value!);
    }
    return runtime;
  }
  async provision(site: string) {
    const instance = await this.instance(site);
    const lock = await this.locks.connect();
    let phase = "state";
    try {
      await lock.query("BEGIN");
      const acquired = (
        await lock.query(
          "SELECT pg_try_advisory_xact_lock(724912,$1::int) AS acquired",
          [instance.id],
        )
      ).rows[0].acquired;
      if (!acquired) return false;
      const latest = await this.instance(site);
      if (latest.state === "ready") return true;
      if (latest.attempts >= 5) {
        await this.pool.query(
          "UPDATE auth_instance SET state='failed',error_code='attempts_exhausted' WHERE id=$1",
          [instance.id],
        );
        return false;
      }
      if (
        instance.center_site &&
        (await this.instance(instance.center_site)).state !== "ready"
      )
        return false;
      await this.pool.query(
        "UPDATE auth_instance SET state='provisioning',attempts=attempts+1,error_code=NULL WHERE id=$1",
        [instance.id],
      );
      phase = "schema";
      const options = await this.options(instance);
      await (await getMigrations(options)).runMigrations();
      if (instance.center_site) {
        phase = "client";
        const center = await this.instance(instance.center_site);
        await (await this.runtime(center)).createClient(instance);
      }
      await this.pool.query(
        "UPDATE auth_instance SET state='ready',schema_version='better-auth@1.7.10',error_code=NULL WHERE id=$1",
        [instance.id],
      );
      return true;
    } catch {
      await this.pool.query(
        "UPDATE auth_instance SET state='failed',error_code=$2,retry_at=now()+interval '30 seconds' WHERE id=$1",
        [instance.id, "provision_" + phase + "_failed"],
      );
      return false;
    } finally {
      try {
        await lock.query("ROLLBACK");
        lock.release();
      } catch {
        lock.release(true);
      }
    }
  }
  async handle(instance: AuthInstance, request: Request) {
    if (instance.state !== "ready")
      throw new HttpError(503, "账号服务正在准备，请稍后重试");
    const path = new URL(request.url).pathname;
    if (path.includes("/admin/")) throw new HttpError(404, "此入口未启用");
    if (
      !this.policy.smtp &&
      (path.includes("password-reset") ||
        path.includes("reset-password") ||
        path.includes("verification-email"))
    )
      throw new HttpError(404, "邮件服务未配置");
    const source = clientIp(request.headers, this.policy.proxyToken);
    await this.limiter.consume("auth:" + instance.site_id, source);
    if (request.method === "POST") {
      const reader = request.clone().body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 16384) {
            await Promise.all([reader.cancel(), request.body?.cancel()]);
            throw new HttpError(413, "认证请求过大");
          }
          chunks.push(part.value);
        }
      }
      if (
        [
          "/api/auth/sign-in/email",
          "/api/auth/sign-up/email",
          "/api/auth/request-password-reset",
          "/api/auth/send-verification-email",
        ].includes(path)
      ) {
        let email = "";
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          email = String(data.email ?? "")
            .trim()
            .toLowerCase();
        } catch {
          throw new HttpError(400, "JSON 格式错误");
        }
        // Keep the email bucket tied to the client source so one caller
        // cannot lock a victim's email address from every other IP.
        await this.limiter.consume(
          "auth-email:" + instance.site_id,
          email + "|" + source,
          10,
        );
      }
    }
    if (
      instance.center_site &&
      ![
        "/api/auth/sign-in/social",
        "/api/auth/callback/network",
        "/api/auth/sign-out",
        "/api/auth/get-session",
      ].includes(path)
    )
      throw new HttpError(404, "入口不存在");
    const headers = new Headers(request.headers);
    headers.delete("x-network-proxy-key");
    headers.delete("x-network-client-ip");
    request = new Request(request, { headers });
    return this.context.run({}, async () => {
      try {
        const runtime = await this.runtime(instance);
        const local = await runtime.session(request.headers);
        let cleared: string[] = [];
        if (
          local &&
          path !== "/api/auth/sign-out" &&
          !(await this.validate(instance, local.session.id, local.user.id))
        ) {
          const logout = await runtime.handler(
            new Request(instance.origin + "/api/auth/sign-out", {
              method: "POST",
              headers: new Headers({
                cookie: request.headers.get("cookie") ?? "",
                origin: instance.origin,
                "content-type": "application/json",
              }),
              body: "{}",
            }),
          );
          if (!logout.ok) throw new HttpError(503, "过期会话清理失败，请重试");
          cleared = logout.headers.getSetCookie();
          // Remove only credentials expired by sign-out; OAuth state belongs to this new flow.
          const expiredNames = new Set(
            cleared.map((cookie) => cookie.slice(0, cookie.indexOf("="))),
          );
          const clean = new Headers(request.headers);
          const remaining = (clean.get("cookie") ?? "")
            .split(";")
            .map((cookie) => cookie.trim())
            .filter(
              (cookie) =>
                cookie &&
                !expiredNames.has(cookie.slice(0, cookie.indexOf("="))),
            );
          if (remaining.length) clean.set("cookie", remaining.join("; "));
          else clean.delete("cookie");
          request = new Request(request, { headers: clean });
        }
        const original = await runtime.handler(request);
        if (!cleared.length) return original;
        const response = new Response(original.body, {
          status: original.status,
          statusText: original.statusText,
          headers: original.headers,
        });
        // Old deletion cookies must precede fresh credentials issued by this operation.
        response.headers.delete("set-cookie");
        for (const cookie of [...cleared, ...original.headers.getSetCookie()])
          response.headers.append("set-cookie", cookie);
        return response;
      } finally {
        const lock = this.context.getStore()?.lock;
        if (lock) {
          try {
            await lock.query("ROLLBACK");
            lock.release();
          } catch {
            lock.release(true);
          }
        }
      }
    });
  }
  async publicOptions(instance: AuthInstance) {
    const providers = instance.center_site
      ? []
      : await this.providers.get(instance.id);
    return {
      shared: !!instance.center_site,
      email: !instance.center_site,
      mail: !!this.policy.smtp && !instance.center_site,
      requireEmail: this.policy.requireEmail,
      providers: providers.map((p) => ({
        id: p.id,
        label: p.label,
        kind: p.kind,
      })),
    };
  }
  async current(instance: AuthInstance, headers: Headers) {
    if (instance.state !== "ready") return null;
    const local = await (await this.runtime(instance)).session(headers);
    if (!local) return null;
    return this.validate(instance, local.session.id, local.user.id);
  }
  private async validate(
    instance: AuthInstance,
    sessionId: string,
    localUser: string,
  ) {
    const { rows } = await this.pool.query(
      `SELECT ss.id,ss.user_id,ss.center_session,ss.space_id,u.email,m.role
   FROM session_bridge b JOIN identity_session ss ON ss.id=b.canonical_session
   JOIN identity_user u ON (u.id,u.space_id)=(ss.user_id,ss.space_id)
   JOIN identity_member m ON (m.site_id,m.user_id,m.space_id)=(ss.site_id,ss.user_id,ss.space_id)
   JOIN site s ON s.id=ss.site_id
   WHERE b.instance_id=$1 AND b.local_session=$2 AND b.local_user=$3 AND ss.site_id=$4
    AND ss.expires_at>now() AND ss.absolute_expires_at>now() AND NOT ss.revoked AND NOT u.banned AND s.active`,
      [instance.id, sessionId, localUser, instance.site_id],
    );
    const identity = rows[0];
    if (!identity) return null;
    if (instance.center_site) {
      const center = await this.instance(instance.center_site);
      const table = prefix(center);
      const valid = await this.pool.query(
        `SELECT 1 FROM ${table}session lib JOIN session_bridge b ON b.instance_id=$1 AND b.local_session=lib.id AND b.local_user=lib."userId"
    JOIN identity_session ss ON ss.id=b.canonical_session WHERE lib.id=$2 AND lib."expiresAt">now() AND ss.expires_at>now() AND ss.absolute_expires_at>now() AND NOT ss.revoked AND ss.user_id=$3 AND ss.space_id=$4`,
        [
          center.id,
          identity.center_session,
          identity.user_id,
          identity.space_id,
        ],
      );
      if (!valid.rowCount) return null;
    }
    return identity as {
      id: string;
      user_id: string;
      email: string;
      role: string;
    };
  }
  async maintain() {
    const instances = (
      await this.pool.query<AuthInstance>(
        "SELECT * FROM auth_instance WHERE state='ready' ORDER BY id",
      )
    ).rows;
    let revoked = 0,
      removed = 0;
    for (const instance of instances) {
      const table = prefix(instance);
      const rows = (
        await this.pool.query(
          `SELECT b.local_session,b.local_user,b.canonical_session FROM session_bridge b JOIN identity_session ss ON ss.id=b.canonical_session WHERE b.instance_id=$1 AND NOT ss.revoked ORDER BY ss.checked_at,ss.id LIMIT 100`,
          [instance.id],
        )
      ).rows;
      for (const row of rows) {
        const local = (
          await this.pool.query(
            `SELECT 1 FROM ${table}session WHERE id=$1 AND "userId"=$2 AND "expiresAt">now()`,
            [row.local_session, row.local_user],
          )
        ).rowCount;
        if (
          !local ||
          !(await this.validate(instance, row.local_session, row.local_user))
        ) {
          await this.pool.query(
            "UPDATE identity_session SET revoked=true WHERE id=$1",
            [row.canonical_session],
          );
          revoked++;
        }
        await this.pool.query(
          "UPDATE identity_session SET checked_at=now() WHERE id=$1",
          [row.canonical_session],
        );
      }
      const result = await this.pool.query(
        `WITH dead AS(SELECT lib.id FROM ${table}session lib WHERE lib."createdAt"<now()-interval '5 minutes' AND (lib."expiresAt"<now() OR NOT EXISTS(SELECT 1 FROM session_bridge b JOIN identity_session ss ON ss.id=b.canonical_session WHERE b.instance_id=$1 AND b.local_session=lib.id AND NOT ss.revoked AND ss.expires_at>now())) LIMIT 100) DELETE FROM ${table}session lib USING dead WHERE lib.id=dead.id`,
        [instance.id],
      );
      removed += result.rowCount ?? 0;
    }
    await transaction(this.pool, async (c) => {
      await c.query("DELETE FROM operator_session WHERE expires_at<now()");
      await c.query("DELETE FROM login_limit WHERE reset_at<now()");
      await c.query("DELETE FROM auth_limit WHERE reset_at<now()");
      const expired = (
        await c.query(
          "SELECT id FROM identity_session WHERE COALESCE(revoked_at,expires_at)<now()-$1::int*interval '1 day' ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED",
          [this.policy.historyDays],
        )
      ).rows.map((r) => r.id);
      if (expired.length) {
        await c.query(
          "DELETE FROM session_bridge WHERE canonical_session=ANY($1::uuid[])",
          [expired],
        );
        await c.query("DELETE FROM identity_session WHERE id=ANY($1::uuid[])", [
          expired,
        ]);
      }
      await c.query(
        "INSERT INTO maintenance_status VALUES('sessions',now(),$1) ON CONFLICT(name) DO UPDATE SET completed_at=now(),detail=$1",
        [{ revoked, removed }],
      );
    });
    await this.mail.maintain(this.policy.historyDays);
    return { revoked, removed };
  }
}
