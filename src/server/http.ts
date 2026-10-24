import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { sourceDownload } from "./source-download.js";
import type { Pool } from "pg";
import { z } from "zod";
import { type AuthPolicy, clientIp } from "./auth-policy.js";
import {
  renderHomeTemplate,
  renderPageTemplate,
  renderTemplate,
  templateCss,
  templateHasHome,
  templateHasPage,
  templateManifest,
  templateSupportsAlternatives,
  templateSupportsComparisons,
} from "./templates.js";
import { themeCss } from "./theme.js";
import { Catalog, NotFound, type SiteContext, type SitemapItem } from "../domain/catalog.js";
import {
  Conflict,
  InvalidReference,
  configSchema,
  pageKeys,
  type Config,
  type PageKey,
} from "../domain/config.js";
import { transaction } from "../domain/transaction.js";
import { AuthRegistry } from "./auth.js";
import { Sites } from "./sites.js";
import { HttpError } from "./operators.js";
import {
  adminPage,
  adminLogin,
  accountPage,
  accountHomePage,
  publicPage,
  staticPage,
  css,
} from "../ui/pages.js";
import { moduleManifest } from "../public/modules.js";
import { GithubSources } from "./github.js";
import { githubHttp } from "./github-http.js";
import { Content, webUrl } from "./content.js";
import { contentHttp } from "./content-http.js";
import { Distribution } from "./distribution.js";
import { distributionHttp } from "./distribution-http.js";
import { AiService } from "./ai.js";
import { Collectors } from "./collectors.js";
import { collectorsHttp } from "./collectors-http.js";
import { aiHttp } from "./ai-http.js";
import { Media } from "./media.js";
import { mediaHttp } from "./media-http.js";
import { Limits, limitsHttp } from "./limits.js";
import { AiBilling, aiBillingHttp } from "./ai-billing.js";
import { DEFAULT_RETENTION, type RetentionPolicy } from "./retention.js";
import { Personal } from "./personal.js";
import { MetadataService } from "./metadata.js";
import { badgeSvg } from "./badge.js";
import { AuditLog } from "./audit.js";
import {
  personalPage,
  rssXml,
  sitemapIndexXml,
  sitemapXml,
  type SitemapUrl,
} from "../ui/directory.js";
// A sitemap file holds at most 50,000 URLs; stay well below it.
const SITEMAP_CHUNK = 45000;
const BODY_LIMIT = 256 * 1024;
const CONFIG_BODY_LIMIT = 1024 * 1024;
const ADMIN_METADATA_HOURLY_LIMIT = 120;
const version = z.strictObject({
  revision: z.number().int().nonnegative(),
  draftVersion: z.number().int().nonnegative(),
});
function pageAlternates(config: Config, key: PageKey, origin: string) {
  if (key === config.catalogPath) return [];
  return config.locales.flatMap((locale) =>
    config.pages?.[key]?.[locale]
      ? [{ locale, url: `${origin}/${locale}/${key}` }]
      : [],
  );
}
export class Application {
  readonly sites: Sites;
  readonly auth: AuthRegistry;
  readonly catalog: Catalog;
  readonly content: Content;
  readonly distribution: Distribution;
  readonly personal: Personal;
  readonly metadata: MetadataService;
  readonly github: GithubSources;
  readonly audit: AuditLog;
  readonly media: Media;
  readonly ai: AiService;
  readonly collectors: Collectors;
  readonly limits: Limits;
  readonly aiBilling: AiBilling;
  private assets = new Map<string, { body: Buffer; etag: string }>();
  constructor(
    readonly pool: Pool,
    readonly config: {
      key: string;
      adminOrigin: string;
      databaseUrl: string;
      development: boolean;
      auth?: AuthPolicy;
      mediaRoot?: string;
      retention?: RetentionPolicy;
      metadataFetcher?: typeof import("./outbound.js").fetchPublicText;
      // Template for newly created sites; toolso unless a caller (tests) asks otherwise.
      defaultTemplate?: string;
    },
  ) {
    this.sites = new Sites(
      pool,
      config.key,
      config.adminOrigin,
      config.development,
      config.defaultTemplate,
    );
    this.auth = new AuthRegistry(
      pool,
      config.key,
      config.databaseUrl,
      config.auth,
    );
    this.catalog = new Catalog(pool);
    this.content = new Content(pool);
    this.distribution = new Distribution(pool, this.content);
    this.personal = new Personal(pool);
    this.metadata = new MetadataService(pool, config.metadataFetcher);
    this.github = new GithubSources(pool, this.content);
    this.audit = new AuditLog(pool);
    this.media = new Media(pool, config.mediaRoot ?? ".local/media");
    this.ai = new AiService(pool, config.key);
    this.collectors = new Collectors(pool);
    this.limits = new Limits(pool);
    this.aiBilling = new AiBilling(pool);
  }
  async close() {
    await this.auth.close();
  }
  private json(value: unknown, status = 200) {
    return Response.json(value, { status });
  }
  private html(value: string) {
    return new Response(value, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  private async asset(file: string, type = "text/javascript") {
    let cached = this.assets.get(file);
    if (!cached) {
      const body = await readFile(resolve("src/ui", file));
      cached = {
        body,
        etag: '"' + createHash("sha256").update(body).digest("base64url").slice(0, 20) + '"',
      };
      this.assets.set(file, cached);
    }
    return new Response(new Uint8Array(cached.body), {
      headers: { "content-type": type, etag: cached.etag },
    });
  }
  async respond(request: Request) {
    let response: Response;
    try {
      response = await this.route(request);
    } catch (error) {
      const code =
        error && typeof error === "object"
          ? (error as { code?: string }).code
          : undefined;
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof NotFound
            ? 404
            : error instanceof Conflict
              ? 409
              : error instanceof InvalidReference || error instanceof z.ZodError
                ? 400
                : code === "23505"
                  ? 409
                  : code === "23503" || code === "22P02"
                    ? 400
                    : 503;
      const message =
        error instanceof HttpError ||
        error instanceof Conflict ||
        error instanceof InvalidReference
          ? error.message
          : status === 400
            ? code === "23503"
              ? "关联的对象不存在或已被删除"
              : "配置格式或参数不正确"
            : status === 409
              ? "记录已存在或版本冲突"
              : status === 404
                ? "Not found"
                : "服务暂不可用，请稍后重试";
      if (status === 503 && !(error instanceof HttpError))
        console.error(
          "Unhandled request error",
          request.method,
          new URL(request.url).pathname,
          error,
        );
      response = this.json({ error: message }, status);
    }
    // Framework and protocol redirects may have immutable headers. Read a
    // cacheable body before constructing the copy: sharing the original stream
    // with another Response would make the original body unusable.
    const path = new URL(request.url).pathname;
    const publicAsset = path.startsWith("/assets/");
    const publicMedia = /^\/media\/[0-9a-f-]{36}\/[1-9][0-9]{0,8}$/.test(path);
    const publicBadge = /^\/badge\/(?:zh|en)\/[a-z][a-z0-9-]{0,63}\.svg$/.test(path);
    const publicPage =
      path === "/" ||
      path === "/sitemap.xml" ||
      path === "/robots.txt" ||
      /^\/[a-z]{2}\/[a-z0-9-]+(?:\/[a-z0-9-]+)?$/.test(path) ||
      /^\/(?:zh|en)(?:\/[a-z0-9-]+\/(?:category|tag|collection)\/[a-z0-9-]+)?$/.test(path) ||
      /^\/(?:zh|en)\/[a-z0-9-]+\/[a-z0-9-]+\/alternatives$/.test(path) ||
      /^\/(?:zh|en)\/[a-z0-9-]+\/compare\/[a-z0-9-]+$/.test(path) ||
      /^\/sitemap-[0-9]+\.xml$/.test(path) ||
      /^\/(?:zh|en)\/feed\.xml$/.test(path);
    const cacheable =
      request.method === "GET" &&
      response.status === 200 &&
      !response.headers.has("set-cookie") &&
      (publicAsset || publicPage || publicMedia || publicBadge);
    const body = cacheable
      ? Buffer.from(await response.arrayBuffer())
      : undefined;
    const copy = new Response(body ?? response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    if (body) {
      const etag =
        '"' +
        createHash("sha256").update(body).digest("base64url").slice(0, 20) +
        '"';
      copy.headers.set(
        "cache-control",
        publicMedia
          ? "public, max-age=31536000, immutable"
          : publicAsset || publicBadge
            ? "public, max-age=3600"
            : "public, max-age=60, must-revalidate",
      );
      copy.headers.set("etag", etag);
      if (request.headers.get("if-none-match") === etag)
        response = new Response(null, { status: 304, headers: copy.headers });
      else response = copy;
    } else {
      response = copy;
      response.headers.set("cache-control", "no-store");
    }
    response.headers.set("x-content-type-options", "nosniff");
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set("x-frame-options", "DENY");
    // Keep a route's own stricter policy (the sandboxed submission image); any other
    // CSP is replaced by the site policy.
    if (!response.headers.get("content-security-policy")?.startsWith("default-src 'none'"))
      response.headers.set(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    return response;
  }
  private async body(request: Request, limit = BODY_LIMIT) {
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new HttpError(415, "请提交 JSON");
    const reader = request.body?.getReader();
    if (!reader) throw new HttpError(400, "缺少请求内容");
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, `请求超过 ${limit / 1024} KiB`);
      }
      chunks.push(part.value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new HttpError(400, "JSON 格式错误");
    }
  }
  private async mediaBody(request: Request) {
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new HttpError(415, "请提交 JSON");
    const reader = request.body?.getReader();
    if (!reader) throw new HttpError(400, "缺少请求内容");
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 15 * 1024 * 1024) {
        await reader.cancel();
        throw new HttpError(413, "图片请求超过 15 MiB");
      }
      chunks.push(part.value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new HttpError(400, "JSON 格式错误");
    }
  }
  private cookie(token: string, maxAge: number) {
    return `network_operator=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.config.adminOrigin.startsWith("https:") ? "; Secure" : ""}`;
  }
  private async route(request: Request): Promise<Response> {
    const host = request.headers.get("host")?.toLowerCase();
    if (!host || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?$/.test(host))
      throw new NotFound();
    const path = new URL(request.url).pathname;
    const admin = host === new URL(this.config.adminOrigin).host;
    let site;
    let mediaContext: import("../domain/catalog.js").SiteContext | undefined;
    if (!admin) {
      mediaContext = await this.catalog.resolve(host);
      site = await this.auth.instance(mediaContext.siteId);
      if (new URL(site.origin).host !== host) throw new NotFound();
    }
    if (path.startsWith("/media/") && request.method === "GET") {
      if (!mediaContext) throw new NotFound();
      const mediaMatch = path.match(
        /^\/media\/([0-9a-f-]{36})(?:\/([1-9][0-9]{0,8}))?$/,
      );
      if (!mediaMatch) throw new NotFound();
      const published = await this.content.publishedMediaVersions(
        mediaContext.siteId,
        mediaMatch[1],
      );
      // Pre-M8 URLs had no version: send them to the newest published version.
      // The target changes on republish, so respond() marks the redirect no-store.
      if (!mediaMatch[2]) {
        if (!published.length) throw new NotFound();
        return new Response(null, {
          status: 302,
          headers: { location: `/media/${mediaMatch[1]}/${published[0]}` },
        });
      }
      const version = Number(mediaMatch[2]);
      if (!published.includes(version)) throw new NotFound();
      const { row, data } = await this.media.publicFile(mediaMatch[1], version);
      if (row.site_id !== mediaContext.siteId) throw new NotFound();
      const etag = `"${row.sha256}"`;
      const headers = {
        "content-type": row.mime,
        "content-length": String(data.length),
        "cache-control": "public, max-age=31536000, immutable",
        etag,
        "x-content-type-options": "nosniff",
      };
      if (request.headers.get("if-none-match") === etag)
        return new Response(null, { status: 304, headers });
      return new Response(data, { headers });
    }
    if (path === "/source.tar.gz") {
      if (request.method !== "GET")
        throw new HttpError(405, "Method not allowed");
      return sourceDownload(request, resolve(".local/source.tar.gz"));
    }
    if (path.startsWith("/assets/")) {
      if (request.method !== "GET")
        throw new HttpError(405, "Method not allowed");
      if (path === "/assets/templates.css")
        return new Response(templateCss, {
          headers: { "content-type": "text/css" },
        });
      if (path === "/assets/network.css")
        return new Response(css, { headers: { "content-type": "text/css" } });
      if (!admin) {
        if (path === "/assets/toolso.css")
          return this.asset("generated/toolso.css", "text/css");
        const font = path.match(/^\/assets\/fonts\/(Geist|GeistMono)-Variable\.woff2$/);
        if (font) return this.asset(`fonts/${font[1]}-Variable.woff2`, "font/woff2");
        const theme = path.match(/^\/assets\/theme\/([0-9a-f]{6})\.css$/);
        if (theme)
          return new Response(themeCss(theme[1]!), {
            headers: { "content-type": "text/css" },
          });
      }
      const file =
        path === "/assets/admin.js" && admin
          ? "admin.js"
          : path === "/assets/account.js" && !admin
            ? "account.js"
            : path === "/assets/account-home.js" && !admin
              ? "account-home.js"
              : path === "/assets/simplewebauthn.js" && !admin
                ? "vendor/simplewebauthn.js"
                : path === "/assets/media-admin.js" && admin
                  ? "media-admin.js"
                  : path === "/assets/ai-admin.js" && admin
                    ? "ai-admin.js"
                    : path === "/assets/collector-admin.js" && admin
                      ? "collector-admin.js"
                    : path === "/assets/limits-admin.js" && admin
                      ? "limits-admin.js"
                    : path === "/assets/ai-billing-admin.js" && admin
                      ? "ai-billing-admin.js"
                  : path === "/assets/github-admin.js" && admin
              ? "github-admin.js"
              : path === "/assets/content-admin.js" && admin
                ? "content-admin.js"
                : path === "/assets/distribution-admin.js" && admin
                  ? "distribution-admin.js"
                : path === "/assets/directory.js" && !admin
                  ? "directory.js"
                  : path === "/assets/toolso.js" && !admin
                    ? "toolso.js"
                    : path === "/assets/toolso-init.js" && !admin
                      ? "toolso-init.js"
                      : null;
      if (!file) throw new NotFound();
      return this.asset(file);
    }
    if (admin) {
      const mediaDelete =
        request.method === "DELETE" && path.startsWith("/admin/api/media/");
      if (request.method !== "GET" && request.method !== "POST" && !mediaDelete)
        throw new HttpError(405, "Method not allowed");
      if (
        request.method !== "GET" &&
        request.headers.get("origin") !== this.config.adminOrigin
      )
        throw new HttpError(403, "来源验证失败");
      if (path === "/health" && request.method === "GET") {
        await this.pool.query("SELECT 1 FROM schema_migration LIMIT 1");
        return this.json({ status: "ok" });
      }
      // The admin origin's root goes to the console, which sends signed-out visitors to login.
      if (path === "/" && request.method === "GET")
        return Response.redirect(this.config.adminOrigin + "/admin", 303);
      if (path === "/admin/login" && request.method === "GET")
        return this.html(adminLogin());
      if (path === "/admin/api/login" && request.method === "POST") {
        await this.auth.limiter.consume(
          "operator-login",
          clientIp(request.headers, this.auth.policy.proxyToken),
          100,
        );
        const body = z
          .strictObject({ email: z.string(), password: z.string() })
          .parse(await this.body(request));
        const token = await this.sites.operators.login(
          body.email,
          body.password,
          clientIp(request.headers, this.auth.policy.proxyToken),
        );
        const response = this.json({ ok: true });
        response.headers.set("set-cookie", this.cookie(token, 28800));
        return response;
      }
      if (path === "/admin/api/logout" && request.method === "POST") {
        await this.sites.operators.logout(request.headers);
        const r = this.json({ ok: true });
        r.headers.set("set-cookie", this.cookie("", 0));
        return r;
      }
      let operator;
      try {
        operator = await this.sites.operators.current(request.headers);
      } catch (error) {
        if (path === "/admin" && request.method === "GET")
          return Response.redirect(
            this.config.adminOrigin + "/admin/login",
            303,
          );
        throw error;
      }
      if (path === "/admin" && request.method === "GET")
        return this.html(adminPage());
      if (!path.startsWith("/admin/api/")) throw new NotFound();
      const action = path.slice("/admin/api".length);
      if (action === "/modules" && request.method === "GET")
        return this.json(moduleManifest);
      if (action === "/templates" && request.method === "GET")
        return this.json(templateManifest);
      const metadataAdmin = action.match(
        /^\/content\/([a-z][a-z0-9-]{0,47})\/metadata$/,
      );
      if (metadataAdmin && request.method === "POST") {
        const siteId = metadataAdmin[1];
        await this.content.operators.require(operator, siteId, true);
        try {
          await this.auth.limiter.consume(
            "metadata-admin:" + siteId,
            operator.id,
            ADMIN_METADATA_HOURLY_LIMIT,
            3600,
          );
        } catch (error) {
          if (error instanceof HttpError && error.status === 429)
            throw new HttpError(
              429,
              `每小时最多自动获取 ${ADMIN_METADATA_HOURLY_LIMIT} 次，请稍后再试`,
            );
          throw error;
        }
        const value = z.strictObject({ url: webUrl }).parse(await this.body(request));
        return this.json(await this.metadata.fetch(value.url, { siteId }));
      }
      if (action === "/me" && request.method === "GET")
        return this.json(operator);
      if (action === "/audit" && request.method === "GET") {
        const query = new URL(request.url).searchParams;
        return this.json(
          await this.audit.list(operator, {
            site: query.get("site") || undefined,
            before: query.get("before") || undefined,
            limit: query.get("limit") || undefined,
          }),
        );
      }
      if (action === "/sites")
        return request.method === "GET"
          ? this.json(await this.sites.list(operator))
          : this.json(
              await this.sites.create(operator, await this.body(request)),
              201,
            );
      const githubResponse = await githubHttp(
        this.github,
        operator,
        action,
        request,
        () => this.body(request),
      );
      if (githubResponse) return githubResponse;
      const distributionResponse = await distributionHttp(
        this.distribution,
        operator,
        action,
        request,
        () => this.body(request),
      );
      if (distributionResponse) return distributionResponse;
      const contentResponse = await contentHttp(
        this.content,
        operator,
        action,
        request,
        () => this.body(request),
        this.media,
      );
      if (contentResponse) return contentResponse;
      const collectorResponse = await collectorsHttp(
        this.collectors,
        operator,
        action,
        request,
        () => this.body(request),
      );
      if (collectorResponse) return collectorResponse;
      // Before aiHttp: it answers 405 for any other /ai/* action.
      const billingResponse = await aiBillingHttp(
        this.aiBilling,
        operator,
        action,
        request,
        () => this.body(request),
      );
      if (billingResponse) return billingResponse;
      const aiResponse = await aiHttp(
        this.ai,
        operator,
        action,
        request,
        () => this.body(request),
      );
      if (aiResponse) return aiResponse;
      const mediaResponse = await mediaHttp(
        this.media,
        this.content,
        operator,
        action,
        request,
        () => this.mediaBody(request),
      );
      if (mediaResponse) return mediaResponse;
      const limitsResponse = await limitsHttp(
        this.limits,
        operator,
        action,
        request,
        () => this.body(request),
      );
      if (limitsResponse) return limitsResponse;
      const match = action.match(
        /^\/sites\/([a-z][a-z0-9-]{0,47})(?:\/([a-z-]+))?$/,
      );
      if (match) {
        const [, id, operation] = match;
        await this.sites.operators.require(
          operator,
          id,
          request.method === "POST",
        );
        const state = await this.sites.config(operator).read(id);
        if (!operation && request.method === "GET") {
          const row = (await this.sites.list(operator)).find(
            (s) => s.id === id,
          );
          if (!row) throw new NotFound();
          return this.json({
            site: row,
            state,
            history: (
              await this.pool.query(
                "SELECT revision,config FROM config_revision WHERE site_id=$1 ORDER BY revision DESC LIMIT 50",
                [id],
              )
            ).rows,
            authProviders: await this.auth.providers.list(operator, id),
          });
        }
        if (operation === "export" && request.method === "GET")
          return this.json(
            await this.sites.export(
              operator,
              id,
              new URL(request.url).searchParams.get("draft") === "true",
            ),
          );
        if (operation === "preview" && request.method === "GET") {
          const candidate = configSchema.parse(state.draft ?? state.config);
          const instance = await this.auth.instance(id);
          return this.html(
            renderTemplate(candidate.template, {
              kind: "directory",
              preview: true,
              site: candidate,
              origin: instance.origin,
              catalogPath: candidate.catalogPath,
              locale: candidate.locales[0],
              canonical: instance.origin,
              result: { total: 0, items: [], page: 1, limit: 24 },
              categories: [],
              q: "",
              alternates: [],
              noindex: true,
            }),
          );
        }
        if (request.method !== "POST")
          throw new HttpError(405, "Method not allowed");
        const input = await this.body(
          request,
          operation === "compare" || operation === "save"
            ? CONFIG_BODY_LIMIT
            : BODY_LIMIT,
        );
        if (operation === "compare") {
          const b = z.strictObject({ snapshot: z.unknown() }).parse(input);
          return this.json(await this.sites.preview(operator, id, b.snapshot));
        }
        if (operation === "save") {
          const b = z
            .strictObject({
              snapshot: z.unknown(),
              expected: version,
              replace: z.boolean().default(false),
            })
            .parse(input);
          return this.json({
            draftVersion: await this.sites.save(
              operator,
              id,
              b.snapshot,
              b.expected,
              b.replace,
            ),
          });
        }
        if (operation === "publish") {
          const b = z
            .strictObject({ expected: version, operationId: z.uuid() })
            .parse(input);
          const revision = await this.sites.publish(
            operator,
            id,
            b.expected,
            b.operationId,
          );
          this.catalog.invalidate(id);
          return this.json({ revision });
        }
        if (operation === "rollback") {
          const b = z
            .strictObject({
              revision: z.number().int().nonnegative(),
              expected: version,
            })
            .parse(input);
          return this.json({
            draftVersion: await this.sites
              .config(operator)
              .rollback(id, b.revision, b.expected),
          });
        }
        if (operation === "status") {
          const b = z.strictObject({ active: z.boolean() }).parse(input);
          await this.sites.status(operator, id, b.active);
          return this.json({ ok: true });
        }
        throw new NotFound();
      }
      await this.sites.operators.require(operator);
      if (action === "/operators") {
        if (request.method === "GET")
          return this.json(
            (
              await this.pool.query(
                `SELECT u.id,u.email,u.global_admin,u.disabled,string_agg(g.site_id||':'||g.role,', ' ORDER BY g.site_id) AS grants FROM operator_user u LEFT JOIN operator_grant g ON g.user_id=u.id GROUP BY u.id ORDER BY email`,
              )
            ).rows,
          );
        const b = z
          .strictObject({ email: z.email(), password: z.string() })
          .parse(await this.body(request));
        return this.json({
          id: await this.sites.operators.create(
            b.email,
            b.password,
            false,
            operator,
          ),
        });
      }
      if (action === "/tasks" && request.method === "GET")
        return this.json({
          github: (
            await this.pool.query(
              "SELECT t.status,count(*)::int AS count FROM collector_task t JOIN collector_source s ON s.id=t.source_id WHERE s.kind='github' GROUP BY t.status",
            )
          ).rows,
          mail: (
            await this.pool.query(
              "SELECT status,count(*)::int AS count FROM mail_queue GROUP BY status",
            )
          ).rows,
          instances: (
            await this.pool.query(
              "SELECT site_id,state,attempts,error_code FROM auth_instance ORDER BY site_id",
            )
          ).rows,
          events: (
            await this.pool.query(
              "SELECT status,count(*)::int AS count FROM outbox GROUP BY status",
            )
          ).rows,
          delivery: (
            await this.pool.query(
              "SELECT site_id,revision FROM config_delivery ORDER BY site_id",
            )
          ).rows,
          eventFailures: (
            await this.pool.query(
              "SELECT id,site_id,revision,attempts,last_error FROM outbox WHERE status='failed' ORDER BY id LIMIT 100",
            )
          ).rows,
          maintenance: (
            await this.pool.query("SELECT * FROM maintenance_status")
          ).rows,
          ai: (
            await this.pool.query(
              "SELECT status,count(*)::int AS count FROM ai_job GROUP BY status",
            )
          ).rows,
          collectors: (
            await this.pool.query(
              "SELECT t.status,count(*)::int AS count FROM collector_task t JOIN collector_source s ON s.id=t.source_id WHERE s.kind<>'github' GROUP BY t.status",
            )
          ).rows,
          retention: this.config.retention ?? DEFAULT_RETENTION,
        });
      if (request.method !== "POST") throw new NotFound();
      const input = await this.body(request);
      if (action === "/grants") {
        const b = z
          .strictObject({
            userId: z.uuid(),
            siteId: z.string(),
            role: z.enum(["viewer", "editor"]),
          })
          .parse(input);
        await this.sites.operators.grant(operator, b.userId, b.siteId, b.role);
        return this.json({ ok: true });
      }
      if (action === "/grants/revoke") {
        const b = z
          .strictObject({ userId: z.uuid(), siteId: z.string() })
          .parse(input);
        await transaction(this.pool, async (c) => {
          await c.query(
            "SELECT role FROM operator_grant WHERE user_id=$1 AND site_id=$2 FOR UPDATE",
            [b.userId, b.siteId],
          );
          await this.sites.operators.require(operator, undefined, false, c);
          await c.query(
            "DELETE FROM operator_grant WHERE user_id=$1 AND site_id=$2",
            [b.userId, b.siteId],
          );
          await c.query(
            "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,'operator.revoke',$3)",
            [operator.id, b.siteId, { userId: b.userId }],
          );
        });
        return this.json({ ok: true });
      }
      if (
        [
          "/operators/disable",
          "/operators/enable",
          "/operators/revoke-sessions",
        ].includes(action)
      ) {
        const b = z.strictObject({ userId: z.uuid() }).parse(input);
        if (action === "/operators/revoke-sessions")
          await this.sites.operators.revokeSessions(operator, b.userId);
        else
          await this.sites.operators.setDisabled(
            operator,
            b.userId,
            action === "/operators/disable",
          );
        return this.json({ ok: true });
      }
      if (action === "/operators/password") {
        const b = z
          .strictObject({ userId: z.uuid(), password: z.string() })
          .parse(input);
        await this.sites.operators.setPassword(operator, b.userId, b.password);
        return this.json({ ok: true });
      }
      if (action === "/tasks/retry-event") {
        const b = z
          .strictObject({ id: z.string().regex(/^[0-9]{1,18}$/) })
          .parse(input);
        await transaction(this.pool, async (c) => {
          await c.query("SELECT id FROM outbox WHERE id=$1 FOR UPDATE", [b.id]);
          await this.sites.operators.require(operator, undefined, false, c);
          const row = (
            await c.query(
              "UPDATE outbox SET status='pending',attempts=0,available_at=now(),lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 AND status='failed' RETURNING site_id",
              [b.id],
            )
          ).rows[0];
          if (!row) throw new HttpError(409, "任务不处于失败状态");
          await c.query(
            "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,'task.retry',$3)",
            [operator.id, row.site_id, { eventId: b.id }],
          );
        });
        return this.json({ ok: true });
      }
      if (action === "/tasks/retry") {
        const b = z.strictObject({ siteId: z.string() }).parse(input);
        await transaction(this.pool, async (c) => {
          await c.query(
            "SELECT site_id FROM auth_instance WHERE site_id=$1 FOR UPDATE",
            [b.siteId],
          );
          await this.sites.operators.require(operator, undefined, false, c);
          const result = await c.query(
            "UPDATE auth_instance SET state='pending',attempts=0,retry_at=now(),error_code=NULL WHERE site_id=$1 AND state='failed' RETURNING site_id",
            [b.siteId],
          );
          if (!result.rowCount) throw new HttpError(409, "任务不处于失败状态");
          await c.query(
            "INSERT INTO audit_event(actor_id,site_id,action) VALUES($1,$2,'auth.retry')",
            [operator.id, b.siteId],
          );
        });
        return this.json({ ok: true });
      }
      throw new NotFound();
    }
    if (!site) throw new NotFound();
    if (path.startsWith("/api/auth/") || path.startsWith("/.well-known/")) {
      const headers = new Headers(request.headers);
      for (const name of [...headers.keys()])
        if (name.startsWith("x-forwarded-") || name === "forwarded")
          headers.delete(name);
      const url = new URL(request.url);
      const canonical = new URL(url.pathname + url.search, site.origin);
      return this.auth.handle(
        site,
        new Request(
          canonical,
          request.method === "GET" || request.method === "HEAD"
            ? { method: request.method, headers }
            : ({
                method: request.method,
                headers,
                body: request.body,
                duplex: "half",
              } as RequestInit),
        ),
      );
    }
    const ctx = await this.catalog.resolve(host);
    const { revision, config } = await this.catalog.configuration(ctx);
    const url = new URL(request.url),
      locale = url.searchParams.get("locale") ?? config.locales[0];
    const badge = path.match(
      /^\/badge\/(zh|en)\/([a-z][a-z0-9-]{0,63})\.svg$/,
    );
    if (badge) {
      if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
      if (!config.locales.includes(badge[1] as "zh" | "en")) throw new NotFound();
      const theme = z.enum(["light", "dark"]).parse(
        url.searchParams.get("theme") ?? "light",
      );
      const item = await this.catalog.detail(ctx, badge[1], badge[2]);
      return new Response(
        badgeSvg({
          locale: badge[1] as "zh" | "en",
          siteName: config.name,
          title: item.title,
          theme,
          accentColor: /^#[0-9a-f]{6}$/i.test(
            config.templateParams.accentColor ?? "",
          )
            ? config.templateParams.accentColor
            : undefined,
        }),
        {
          headers: {
            "content-type": "image/svg+xml; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        },
      );
    }
    if (path.startsWith("/api/me/")) {
      const user = await this.auth.current(site, request.headers);
      if (!user) throw new HttpError(401, "请先登录");
      if (request.method === "POST") {
        if (request.headers.get("origin") !== site.origin)
          throw new HttpError(403, "来源验证失败");
        // A submission may carry a base64 image of up to 1 MiB.
        const input = await this.body(
          request,
          path === "/api/me/submissions" ? 2 * 1024 * 1024 : BODY_LIMIT,
        );
        if (path === "/api/me/favorites") {
          const value = z
            .strictObject({ resourceId: z.string(), enabled: z.boolean() })
            .parse(input);
          return this.json(
            await this.personal.favorite(
              ctx.siteId,
              user,
              value.resourceId,
              value.enabled,
            ),
          );
        }
        if (path === "/api/me/submissions")
          return this.json(
            await this.personal.submit(ctx.siteId, user, input),
            201,
          );
        if (path === "/api/me/submissions/metadata") {
          const value = z.strictObject({ url: webUrl }).parse(input);
          return this.json(
            await this.metadata.fetch(value.url, {
              siteId: ctx.siteId,
              userId: user.user_id,
            }),
          );
        }
      } else if (request.method === "GET") {
        if (path === "/api/me/favorites")
          return this.json(
            await this.catalog.browse(
              ctx,
              { locale, page: url.searchParams.get("page") ?? 1 },
              user.user_id,
            ),
          );
        if (path === "/api/me/submissions")
          return this.json(
            await this.personal.submissions(
              ctx.siteId,
              user,
              url.searchParams.get("page") ?? 1,
            ),
          );
      }
      throw new NotFound();
    }
    if (request.method !== "GET")
      throw new HttpError(405, "Method not allowed");
    if (path === "/api/account/options")
      return this.json(await this.auth.publicOptions(site));
    if (path === "/account") {
      if (site.center_site) {
        const center = await this.auth.instance(site.center_site);
        return new Response(null, {
          status: 303,
          headers: { location: center.origin + "/account" },
        });
      }
      const identity = await this.auth.current(site, request.headers);
      if (!identity)
        return new Response(null, {
          status: 303,
          headers: { location: "/login?returnTo=%2Faccount" },
        });
      const options = await this.auth.publicOptions(site);
      return this.html(
        accountHomePage(config.name, identity.email, options.providers),
      );
    }
    if (["/login", "/forgot-password", "/reset-password"].includes(path)) {
      const options = await this.auth.publicOptions(site);
      if (path !== "/login" && !options.mail)
        return new Response(null, {
          status: 303,
          headers: { location: "/login" },
        });
      return this.html(
        accountPage(config.name, !!site.center_site, path, options),
      );
    }
    if (path === "/api/session") {
      const identity = await this.auth.current(site, request.headers);
      return this.json(
        identity ? { email: identity.email, role: identity.role } : null,
      );
    }
    if (path === "/api/config") return this.json({ revision, config });
    const options = {
      locale,
      q: url.searchParams.get("q") ?? "",
      category: url.searchParams.get("category") || undefined,
      tag: url.searchParams.get("tag") || undefined,
      collection: url.searchParams.get("collection") || undefined,
      page: url.searchParams.get("page") ?? 1,
    };
    if (path === "/api/catalog")
      return this.json(await this.catalog.list(ctx, locale));
    if (path === "/api/search")
      return this.json(await this.catalog.browse(ctx, options));
    if (path === "/api/categories")
      return this.json(await this.catalog.categories(ctx, locale));
    if (path === "/api/tags")
      return this.json(await this.catalog.tags(ctx, locale));
    if (path === "/api/collections")
      return this.json(await this.catalog.collections(ctx, locale));
    if (path === "/robots.txt")
      return new Response(
        `User-agent: *\nAllow: /\nSitemap: ${site.origin}/sitemap.xml\n`,
        {
          headers: {
            "content-type": "text/plain; charset=utf-8",
          },
        },
      );
    const sitemapPart = path.match(/^\/sitemap-([1-9][0-9]{0,4})\.xml$/);
    if (path === "/sitemap.xml" || sitemapPart) {
      const xml = (body: string) =>
        new Response(body, { headers: { "content-type": "application/xml; charset=utf-8" } });
      const pages = await this.sitemapPageUrls(ctx, site.origin, config);
      const itemCount = await this.catalog.sitemapItemCount(ctx);
      const total = pages.length + itemCount;
      // Small sites get one urlset; larger ones an index computed without reading entries.
      if (path === "/sitemap.xml" && total <= SITEMAP_CHUNK) {
        const items = await this.catalog.sitemapItems(ctx, itemCount, 0);
        return xml(
          sitemapXml([
            ...pages,
            ...items.map((item) => this.sitemapItemUrl(site.origin, config, item)),
          ]),
        );
      }
      const parts = Math.ceil(total / SITEMAP_CHUNK);
      if (path === "/sitemap.xml")
        return xml(
          sitemapIndexXml(
            Array.from({ length: parts }, (_, i) => `${site.origin}/sitemap-${i + 1}.xml`),
          ),
        );
      const index = Number(sitemapPart![1]);
      if (total <= SITEMAP_CHUNK || index > parts) throw new NotFound();
      const start = (index - 1) * SITEMAP_CHUNK;
      const end = Math.min(start + SITEMAP_CHUNK, total);
      const pageStart = Math.min(start, pages.length);
      const pageEnd = Math.min(end, pages.length);
      const itemStart = Math.max(0, start - pages.length);
      const itemEnd = Math.max(0, end - pages.length);
      const items =
        itemEnd > itemStart
          ? await this.catalog.sitemapItems(ctx, itemEnd - itemStart, itemStart)
          : [];
      return xml(
        sitemapXml([
          ...pages.slice(pageStart, pageEnd),
          ...items.map((item) => this.sitemapItemUrl(site.origin, config, item)),
        ]),
      );
    }
    const feed = path.match(/^\/(zh|en)\/feed\.xml$/);
    if (feed) {
      if (!config.locales.includes(feed[1] as "zh" | "en")) throw new NotFound();
      const items = await this.catalog.latest(ctx, feed[1], 50);
      return new Response(
        rssXml({
          title: config.name,
          link: `${site.origin}/${feed[1]}/${config.catalogPath}`,
          self: `${site.origin}${path}`,
          description: config.tagline || config.name,
          language: feed[1] === "zh" ? "zh-CN" : "en",
          items: items.map((item) => ({
            title: item.title,
            link: `${site.origin}/${item.locale}/${config.catalogPath}/${item.slug}`,
            description: item.details?.tagline || item.description,
            published: item.published_at,
          })),
        }),
        { headers: { "content-type": "application/rss+xml; charset=utf-8" } },
      );
    }
    if (path === "/me")
      return this.html(personalPage(config.name, config.locales));
    const item = path.match(/^\/api\/items\/(zh|en)\/([a-z][a-z0-9-]{0,63})$/);
    if (item)
      return this.json(await this.catalog.detail(ctx, item[1], item[2]));
    const parts = path.split("/");
    const language = path === "/" ? config.locales[0] : parts[1];
    const localeRoot = parts.length === 2 && path !== "/";
    // Static pages live at /<locale>/<key>. A catalog path with the same name wins.
    const staticKey =
      parts.length === 3 && pageKeys.includes(parts[2] as PageKey)
        ? (parts[2] as PageKey)
        : null;
    if (staticKey && staticKey !== config.catalogPath) {
      if (!config.locales.includes(language as "zh" | "en")) throw new NotFound();
      const copy = config.pages?.[staticKey]?.[language as "zh" | "en"];
      if (!copy) throw new NotFound();
      const alternates = pageAlternates(config, staticKey, site.origin);
      const page = {
        kind: "page" as const,
        key: staticKey,
        title: copy.title,
        content: copy.content,
        site: config,
        origin: site.origin,
        catalogPath: config.catalogPath,
        locale: language,
        canonical: site.origin + path,
        alternates,
        noindex: false,
      };
      return this.html(
        templateHasPage(config.template)
          ? renderPageTemplate(config.template, page)
          : staticPage(config.name, { ...copy, locale: language }, page.canonical, alternates),
      );
    }
    if (
      !config.locales.includes(language as "zh" | "en") ||
      (path !== "/" &&
        !localeRoot &&
        (parts[2] !== config.catalogPath ||
          (parts.length > 4 &&
            !(parts.length === 5 &&
              (["category", "tag", "collection", "compare"].includes(parts[3]!) ||
                parts[4] === "alternatives")))))
    )
      throw new NotFound();
    if (localeRoot && !templateHasHome(config.template)) throw new NotFound();
    // The default locale's home is "/", matching alternates/x-default, localePath() and
    // lib/seo.ts. Keep query strings (the redirect is still a canonical URL).
    if (localeRoot && language === config.locales[0])
      return new Response(null, {
        status: 308,
        headers: { location: "/" + url.search },
      });
    // Query-string collection filters on the catalog root have a canonical term URL.
    if (
      parts.length === 3 &&
      options.collection &&
      /^[a-z][a-z0-9-]{0,63}$/.test(options.collection)
    ) {
      const params = new URLSearchParams(url.searchParams);
      params.delete("collection");
      const search = params.toString();
      return new Response(null, {
        status: 308,
        headers: {
          location:
            `/${language}/${config.catalogPath}/collection/${options.collection}` +
            (search ? "?" + search : ""),
        },
      });
    }
    if ((path === "/" || localeRoot) && templateHasHome(config.template)) {
      const [featured, categories, lists] = await Promise.all([
        this.catalog.browse(ctx, { locale: language, limit: 12 }),
        this.catalog.categories(ctx, language),
        this.catalog.collections(ctx, language),
      ]);
      // The first four collections, eight entries each, in curated order.
      const shown = lists.slice(0, 4);
      const items = await this.catalog.collectionItems(
        ctx,
        language,
        shown.map((list) => list.id),
        8,
      );
      const collections = shown.map((list) => ({
        ...list,
        items: items.get(list.id) ?? [],
      }));
      return this.html(
        renderHomeTemplate(config.template, {
          kind: "home",
          site: config,
          origin: site.origin,
          catalogPath: config.catalogPath,
          locale: language,
          total: featured.total,
          featured: featured.items,
          categories,
          collections,
          canonical: site.origin + (path === "/" ? "/" : `/${language}`),
          alternates: config.locales.map((l) => ({
            locale: l,
            url: site.origin + (l === config.locales[0] ? "/" : `/${l}`),
          })),
          noindex: false,
        }),
      );
    }
    if (parts.length === 4) {
      try {
        const item = await this.catalog.detail(ctx, language, parts[3]);
        const [alternates, categories, related] = await Promise.all([
          this.catalog.alternates(ctx, item.resource_id),
          this.catalog.categories(ctx, language),
          item.category_id
            ? this.catalog.browse(ctx, {
                locale: language,
                category: item.category_id,
                limit: 7,
              })
            : null,
        ]);
        const comparisons = templateSupportsComparisons(config.template)
          ? await this.catalog.comparisons(ctx, language, {
              resourceId: item.resource_id,
              limit: 50,
            })
          : [];
        return this.html(
          renderTemplate(config.template, {
            kind: "detail",
            site: config,
            origin: site.origin,
            catalogPath: config.catalogPath,
            locale: language,
            item,
            categories,
            related: (related?.items ?? [])
              .filter((r) => r.resource_id !== item.resource_id)
              .slice(0, 6),
            comparisons: comparisons.flatMap(({ resource_a: _a, resource_b: _b, other, ...comparison }) =>
              other ? [{ ...comparison, content: "", other }] : [],
            ),
            canonical:
              site.origin + `/${language}/${config.catalogPath}/${item.slug}`,
            alternates: alternates.map((a) => ({
              locale: a.locale,
              url: site.origin + `/${a.locale}/${config.catalogPath}/${a.slug}`,
            })),
            noindex: false,
          }),
        );
      } catch (error) {
        if (!(error instanceof NotFound)) throw error;
        return new Response(
          renderTemplate(config.template, {
            kind: "missing",
            site: config,
            origin: site.origin,
            catalogPath: config.catalogPath,
            locale: language,
            canonical:
              site.origin + `/${language}/${config.catalogPath}/${parts[3]}`,
            alternates: (
              await this.catalog.availableForSlug(ctx, parts[3])
            ).map((a) => ({
              locale: a.locale,
              url: site.origin + `/${a.locale}/${config.catalogPath}/${a.slug}`,
            })),
            noindex: true,
          }),
          {
            status: 404,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      }
    }
    // /<locale>/<catalog>/compare/<a>-vs-<b>: a reviewed comparison of two visible entries.
    if (parts.length === 5 && parts[3] === "compare") {
      if (!templateSupportsComparisons(config.template)) throw new NotFound();
      const found = await this.catalog.comparison(ctx, language, parts[4]!);
      if (!found) throw new NotFound();
      const { items, ...comparison } = found;
      // Other languages only where the same comparison is published and visible.
      const alternates = (
        await Promise.all(
          config.locales.map(async (l) =>
            l === language || (await this.catalog.comparisons(ctx, l, { id: found.id, limit: 1 })).length ? l : null,
          ),
        )
      ).filter((l): l is "zh" | "en" => !!l);
      return this.html(
        renderTemplate(config.template, {
          kind: "directory",
          site: config,
          origin: site.origin,
          catalogPath: config.catalogPath,
          locale: language,
          result: { total: 2, items, page: 1, limit: 2 },
          categories: await this.catalog.categories(ctx, language),
          q: "",
          comparison,
          canonical: site.origin + path,
          alternates: alternates.map((l) => ({
            locale: l,
            url: `${site.origin}/${l}/${config.catalogPath}/compare/${found.id}`,
          })),
          noindex: false,
        }),
      );
    }
    // /<locale>/<catalog>/<slug>/alternatives: entries sharing categories or tags.
    if (
      parts.length === 5 &&
      parts[4] === "alternatives" &&
      !["category", "tag", "collection", "compare"].includes(parts[3]!)
    ) {
      if (!templateSupportsAlternatives(config.template)) throw new NotFound();
      const item = await this.catalog.detail(ctx, language, parts[3]!);
      const [items, categories, versions] = await Promise.all([
        this.catalog.alternatives(ctx, language, item.resource_id, 24),
        this.catalog.categories(ctx, language),
        this.catalog.alternates(ctx, item.resource_id),
      ]);
      const noindex = items.length < 3;
      const alternates = noindex
        ? []
        : (
            await Promise.all(
              versions.map(async (version) => {
                const enough =
                  version.locale === language
                    ? true
                    : (await this.catalog.alternatives(ctx, version.locale, item.resource_id, 3)).length >= 3;
                return enough
                  ? {
                      locale: version.locale,
                      url: `${site.origin}/${version.locale}/${config.catalogPath}/${version.slug}/alternatives`,
                    }
                  : null;
              }),
            )
          ).filter((value): value is { locale: string; url: string } => !!value);
      return this.html(
        renderTemplate(config.template, {
          kind: "directory",
          site: config,
          origin: site.origin,
          catalogPath: config.catalogPath,
          locale: language,
          result: { total: items.length, items, page: 1, limit: 24 },
          categories,
          q: "",
          alternativesOf: item,
          canonical: site.origin + path,
          alternates,
          // A thin list is not worth indexing.
          noindex,
        }),
      );
    }
    const [categories, tags, collections] = await Promise.all([
      this.catalog.categories(ctx, language),
      this.catalog.tags(ctx, language),
      parts[3] === "collection" ? this.catalog.collections(ctx, language) : [],
    ]);
    // /<locale>/<catalog>/category/<id>, /tag/<id> and /collection/<id> are indexable term pages.
    const termKind =
      parts.length === 5 ? (parts[3] as "category" | "tag" | "collection") : null;
    const term = termKind
      ? { category: categories, tag: tags, collection: collections }[termKind].find(
          (c) => c.id === parts[4],
        )
      : undefined;
    if (termKind && !term) throw new NotFound();
    const categoryPage = termKind === "category" ? term : undefined;
    const tagPage = termKind === "tag" ? term : undefined;
    const collectionPage =
      termKind === "collection" ? collections.find((c) => c.id === term!.id) : undefined;
    const base = term
      ? `/${config.catalogPath}/${termKind}/${term.id}`
      : `/${config.catalogPath}`;
    const result = await this.catalog.browse(ctx, {
      ...options,
      category: categoryPage?.id ?? options.category,
      tag: tagPage?.id ?? options.tag,
      collection: collectionPage?.id,
      locale: language,
    });
    const termLocales =
      term && termKind && result.page === 1
        ? new Set(await this.catalog.taxonomyLocales(ctx, termKind, term.id))
        : null;
    return this.html(
      renderTemplate(config.template, {
        kind: "directory",
        site: config,
        origin: site.origin,
        catalogPath: config.catalogPath,
        locale: language,
        result,
        categories,
        tags,
        q: options.q,
        category: categoryPage?.id ?? options.category,
        tag: tagPage?.id ?? options.tag,
        ...(categoryPage ? { categoryPage } : {}),
        ...(tagPage ? { tagPage } : {}),
        ...(collectionPage ? { collectionPage } : {}),
        canonical:
          site.origin +
          `/${language}${base}` +
          (result.page > 1 ? "?page=" + result.page : ""),
        alternates:
          result.page > 1
            ? []
            : config.locales
                .filter((l) => !termLocales || termLocales.has(l))
                .map((l) => ({
                  locale: l,
                  url: site.origin + `/${l}${base}`,
                })),
        noindex:
          !!options.q ||
          (!!options.category && !categoryPage) ||
          (!!options.tag && !tagPage),
      }),
    );
  }
  // Home, catalog, term pages (category/tag/collection) and comparisons per language.
  // Entries are fetched separately, page by page, by the sitemap route.
  private async sitemapPageUrls(ctx: SiteContext, origin: string, config: Config) {
    const pages: SitemapUrl[] = [];
    const hasHome = templateHasHome(config.template);
    const hasComparisons = templateSupportsComparisons(config.template);
    for (const locale of config.locales) {
      if (locale === config.locales[0]) pages.push({ loc: origin + "/" });
      else if (hasHome) pages.push({ loc: `${origin}/${locale}` });
      const catalog = `${origin}/${locale}/${config.catalogPath}`;
      pages.push({ loc: catalog });
      const [categories, tags, collections] = await Promise.all([
        this.catalog.categories(ctx, locale),
        this.catalog.tags(ctx, locale),
        this.catalog.collections(ctx, locale),
      ]);
      for (const [kind, terms] of [
        ["category", categories],
        ["tag", tags],
        ["collection", collections],
      ] as const)
        for (const term of terms) pages.push({ loc: `${catalog}/${kind}/${term.id}` });
      for (const key of pageKeys) {
        if (key === config.catalogPath || !config.pages?.[key]?.[locale]) continue;
        const alternates = pageAlternates(config, key, origin);
        pages.push({
          loc: `${origin}/${locale}/${key}`,
          alternates: alternates.map((alternate) => ({
            locale: alternate.locale,
            href: alternate.url,
          })),
        });
      }
      if (hasComparisons)
        for (const comparison of await this.catalog.comparisons(ctx, locale))
          pages.push({ loc: `${catalog}/compare/${comparison.id}`, lastmod: comparison.updated_at });
    }
    return pages;
  }
  private sitemapItemUrl(origin: string, config: Config, item: SitemapItem): SitemapUrl {
    return {
      loc: `${origin}/${item.locale}/${config.catalogPath}/${item.slug}`,
      lastmod: item.updated_at,
      alternates: item.alternates.map((alternate) => ({
        locale: alternate.locale,
        href: `${origin}/${alternate.locale}/${config.catalogPath}/${alternate.slug}`,
      })),
    };
  }

}
