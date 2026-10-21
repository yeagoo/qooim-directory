import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { readFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { chromium } from "@playwright/test";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { database } from "../../p0/tests/database.js";
import { migrate } from "../../src/server/migrate.js";
import { Application } from "../../src/server/http.js";
import { prefix } from "../../src/server/auth.js";
import type { Operator } from "../../src/server/operators.js";
let pool: Pool,
  app: Application,
  server: ReturnType<typeof createServer>,
  admin: Operator,
  origins: string[],
  key: string;
const password = "P3-test-password-429!";
import { smtpReceiver } from "./smtp.js";
import { unseal } from "../../src/server/crypto.js";
import {
  type AuthPolicy,
  clientIp,
  authPolicy,
} from "../../src/server/auth-policy.js";
import { MailQueue } from "../../src/server/mail.js";
import { IdentityStore } from "../../src/domain/identity.js";
import { oidcDiscovery } from "../../src/server/providers.js";
import { renderTemplate } from "../../src/server/templates.js";
import { accountPage } from "../../src/ui/pages.js";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
let smtp: Awaited<ReturnType<typeof smtpReceiver>>,
  policy: AuthPolicy,
  lab: {
    handler: (request: Request) => Promise<Response>;
    api: {
      signInEmail: (input: {
        body: { email: string; password: string };
        asResponse: true;
      }) => Promise<Response>;
      signUpEmail: (input: {
        body: { email: string; password: string; name: string };
      }) => Promise<unknown>;
    };
  },
  labIssuer: string;
let labClient: { clientId: string; clientSecret: string };

before(async () => {
  await mkdir(".local", { recursive: true });
  pool = await database();
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await Promise.all([migrate(pool), migrate(pool)]);
  smtp = await smtpReceiver();
  policy = {
    smtp: {
      host: "127.0.0.1",
      port: smtp.port,
      secure: false,
      allowInsecure: true,
      from: "accounts@example.test",
    },
    requireEmail: true,
    sessionSeconds: 604800,
    updateSeconds: 86400,
    absoluteSeconds: 2592000,
    historyDays: 30,
  };
  key = randomBytes(32).toString("hex");
  server = createServer(
    {
      key: await readFile(process.env.P0_TLS_KEY!),
      cert: await readFile(process.env.P0_TLS_CERT!),
    },
    async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const request = new Request("https://" + req.headers.host + req.url, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          ...(!["GET", "HEAD"].includes(req.method!)
            ? { body: Buffer.concat(chunks) }
            : {}),
        });
        const response = new URL(request.url).pathname.startsWith("/lab/auth/")
          ? await lab.handler(request)
          : await app.respond(request);
        res.statusCode = response.status;
        for (const [name, value] of response.headers)
          if (name !== "set-cookie") res.setHeader(name, value);
        const cookies = response.headers.getSetCookie();
        if (cookies.length) res.setHeader("set-cookie", cookies);
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.statusCode = 500;
        res.end("Test transport failed");
      }
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  origins = process.env
    .P0_HOSTS!.split(",")
    .map((host) => `https://${host}:${port}`);
  app = new Application(pool, {
    key,
    adminOrigin: origins[3],
    databaseUrl: process.env.P0_DATABASE_URL!,
    development: false,
    auth: policy,
  });
  const id = await app.sites.operators.create(
    "owner@example.test",
    password,
    true,
  );
  admin = { id, email: "owner@example.test", global_admin: true };
  for (const [index, id] of ["atlas", "notes", "library"].entries())
    await app.sites.create(admin, {
      id,
      name: ["灵感地图", "开发札记", "资源书房"][index],
      origin: origins[index],
      centerSite: index === 1 ? "atlas" : null,
    });
  for (const id of ["atlas", "notes", "library"])
    assert.equal(await app.auth.provision(id), true);
  labIssuer = origins[2] + "/lab/auth";
  const labOptions = {
    database: pool,
    baseURL: origins[2],
    basePath: "/lab/auth",
    secret: randomBytes(32).toString("hex"),
    trustedOrigins: [origins[2]],
    user: { modelName: "lab_user" },
    session: { modelName: "lab_session" },
    account: { modelName: "lab_account" },
    verification: { modelName: "lab_verification" },
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
    rateLimit: { enabled: false },
    plugins: [
      jwt({ schema: { jwks: { modelName: "lab_jwks" } } }),
      oauthProvider({
        loginPage: "/lab-login",
        consentPage: "/lab-login",
        scopes: ["openid", "profile", "email"],
        clientPrivileges: ({ user }: { user?: { email: string } }) =>
          user?.email === "lab-admin@example.test",
        schema: {
          oauthClient: { modelName: "lab_oauth_client" },
          oauthResource: { modelName: "lab_oauth_resource" },
          oauthClientResource: { modelName: "lab_oauth_client_resource" },
          oauthRefreshToken: { modelName: "lab_oauth_refresh" },
          oauthAccessToken: { modelName: "lab_oauth_access" },
          oauthConsent: { modelName: "lab_oauth_consent" },
          oauthClientAssertion: { modelName: "lab_oauth_assertion" },
        },
      }),
    ],
  };
  await (await getMigrations(labOptions)).runMigrations();
  const laboratory = betterAuth(labOptions);
  lab = laboratory;
  const signup = await laboratory.api.signUpEmail({
    body: { email: "lab-admin@example.test", password, name: "Lab admin" },
    asResponse: true,
  });
  const cookie = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const client = await laboratory.api.adminCreateOAuthClient({
    headers: new Headers({ cookie }),
    body: {
      redirect_uris: [origins[0] + "/api/auth/callback/oidc-lab"],
      scope: "openid profile email",
      grant_types: ["authorization_code"],
      skip_consent: true,
      require_pkce: true,
      token_endpoint_auth_method: "client_secret_post",
    },
  });
  labClient = {
    clientId: client.client_id,
    clientSecret: client.client_secret!,
  };
  await laboratory.api.signUpEmail({
    body: {
      email: "external-reader@example.test",
      password,
      name: "External reader",
    },
  });
  await pool.query('UPDATE lab_user SET "emailVerified"=true WHERE email=$1', [
    "external-reader@example.test",
  ]);
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await app?.close();
  await pool?.end();
  await smtp?.close();
});

async function link(kind: string, email: string) {
  const rows = (
    await pool.query(
      "SELECT payload FROM mail_queue WHERE kind=$1 AND payload IS NOT NULL ORDER BY created_at DESC",
      [kind],
    )
  ).rows;
  const message = rows
    .map((r) => unseal<{ to: string; url: string }>(r.payload, key))
    .find((m) => m.to === email);
  assert.ok(message, "queued mail for " + email);
  return message.url;
}
async function register(
  context: import("@playwright/test").BrowserContext,
  index: number,
  email: string,
) {
  const result = await context.request.post(
    origins[index] + "/api/auth/sign-up/email",
    {
      data: {
        email,
        password,
        name: "Reader",
        callbackURL: origins[index] + "/login?verified=1",
      },
      headers: { origin: origins[index] },
    },
  );
  assert.equal(result.status(), 200);
  return result;
}
async function verify(
  context: import("@playwright/test").BrowserContext,
  email: string,
) {
  const result = await context.request.get(await link("verify", email));
  assert.equal(result.status(), 200);
}
async function canonicalSession(site: string, email: string) {
  return (
    await pool.query(
      `SELECT ss.id FROM identity_session ss
       JOIN identity_user u ON u.id=ss.user_id AND u.space_id=ss.space_id
       WHERE ss.site_id=$1 AND u.email=$2 AND NOT ss.revoked
       ORDER BY ss.created_at DESC LIMIT 1`,
      [site, email],
    )
  ).rows[0]?.id as string | undefined;
}
async function login(
  context: import("@playwright/test").BrowserContext,
  index: number,
  email: string,
  pass = password,
) {
  return context.request.post(origins[index] + "/api/auth/sign-in/email", {
    data: { email, password: pass },
    headers: { origin: origins[index] },
  });
}

test("P3 template SDK renders registered templates, escapes text and rejects incompatible parameters", async () => {
  const snapshot = await app.sites.export(admin, "atlas");
  snapshot.config.template = "editorial";
  snapshot.config.templateParams = {
    accent: "terracotta",
    eyebrow: "AI reading room <script>",
  };
  let state = await app.sites.config(admin).read("atlas");
  const draft = await app.sites.save(admin, "atlas", snapshot, {
    revision: state.revision,
    draftVersion: state.draft_version,
  });
  await app.sites.publish(admin, "atlas", {
    revision: state.revision,
    draftVersion: draft,
  });
  app.catalog.invalidate("atlas");
  const response = await app.respond(
    new Request(origins[0] + "/", {
      headers: { host: new URL(origins[0]).host },
    }),
  );
  const html = await response.text();
  assert.match(html, /template-editorial/);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.match(html, /accent-terracotta/);
  const bad = await app.sites.export(admin, "atlas");
  bad.config.templateParams = { accent: "invalid" as "forest" };
  state = await app.sites.config(admin).read("atlas");
  await assert.rejects(
    app.sites.save(admin, "atlas", bad, {
      revision: state.revision,
      draftVersion: state.draft_version,
    }),
  );
  assert.throws(() => renderTemplate("missing", {} as never));
});

test("P3 verification mails are encrypted, SMTP-delivered, and unverified accounts cannot sign in", async () => {
  const browser = await chromium.launch(),
    context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await register(context, 0, "verify@example.test");
    assert.equal(
      (await login(context, 0, "verify@example.test")).status(),
      403,
    );
    const url = await link("verify", "verify@example.test");
    assert.ok(url.startsWith(origins[0] + "/api/auth/verify-email"));
    const stored = (
      await pool.query(
        "SELECT payload FROM mail_queue WHERE kind='verify' ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0].payload;
    assert.ok(
      !stored.includes("verify@example.test") && !stored.includes("token="),
    );
    await verify(context, "verify@example.test");
    assert.equal(
      (await login(context, 0, "verify@example.test")).status(),
      200,
    );
    const other = origins[2] + new URL(url).pathname + new URL(url).search;
    await context.request.get(other);
    assert.equal(
      (await login(context, 2, "verify@example.test")).status(),
      401,
    );
    await app.auth.mail.runOnce();
    assert.equal(smtp.messages.length, 1);
    assert.ok(smtp.messages[0].includes("Verify your email"));
    assert.equal(
      (
        await pool.query(
          "SELECT payload FROM mail_queue WHERE status='done' LIMIT 1",
        )
      ).rows[0].payload,
      null,
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P3 password reset is single-use and revokes center and relying-site product sessions", async () => {
  const browser = await chromium.launch(),
    context = await browser.newContext({ ignoreHTTPSErrors: true }),
    page = await context.newPage();
  page.setDefaultTimeout(10000);
  try {
    await register(context, 0, "reset@example.test");
    await verify(context, "reset@example.test");
    await login(context, 0, "reset@example.test");
    await page.goto(origins[1] + "/login");
    await page.locator("button").click();
    await page.waitForURL(origins[1] + "/");
    assert.ok(
      await (await context.request.get(origins[1] + "/api/session")).json(),
    );
    assert.equal(
      (
        await context.request.post(
          origins[0] + "/api/auth/request-password-reset",
          {
            data: {
              email: "reset@example.test",
              redirectTo: origins[0] + "/reset-password",
            },
            headers: { origin: origins[0] },
          },
        )
      ).status(),
      200,
    );
    const message = await link("reset", "reset@example.test");
    await page.goto(message);
    await page.waitForURL(origins[0] + "/reset-password?**");
    const token = new URL(page.url()).searchParams.get("token");
    assert.ok(token);
    await page.locator("#password").fill(password + "-new");
    await page.locator("button").click();
    await page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.startsWith("密码已更新"),
    );
    assert.equal(
      await (await context.request.get(origins[1] + "/api/session")).json(),
      null,
    );
    assert.equal(
      await (await context.request.get(origins[0] + "/api/session")).json(),
      null,
    );
    assert.equal(
      (
        await context.request.post(origins[0] + "/api/auth/reset-password", {
          data: { token, newPassword: password },
          headers: { origin: origins[0] },
        })
      ).status(),
      400,
    );
    assert.equal(
      (
        await login(context, 0, "reset@example.test", password + "-new")
      ).status(),
      200,
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P3 SMTP outage retries without exposing payload; expired messages cannot be delivered", async () => {
  await app.auth.mail.enqueue(
    "atlas",
    origins[0],
    "reset",
    "retry@example.test",
    origins[0] + "/api/auth/reset-password/test",
  );
  const broken = new MailQueue(pool, key, { ...policy.smtp!, port: 1 });
  await broken.runOnce();
  assert.ok(
    (
      await pool.query(
        "SELECT 1 FROM mail_queue WHERE error_code='smtp_failed' AND status='pending'",
      )
    ).rowCount,
  );
  await pool.query(
    "UPDATE mail_queue SET expires_at=now()-interval '1 second' WHERE status='pending'",
  );
  const before = smtp.messages.length;
  await app.auth.mail.runOnce();
  assert.equal(smtp.messages.length, before);
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM mail_queue WHERE status='failed' AND payload IS NULL",
      )
    ).rowCount! > 0,
    true,
  );
});

test("P3 auth limits survive an app restart and untrusted forwarded headers cannot pick an IP", async () => {
  assert.equal(
    clientIp(
      new Headers({
        "x-forwarded-for": "1.2.3.4",
        "x-network-client-ip": "1.2.3.4",
        "x-network-proxy-key": "wrong",
      }),
      "a".repeat(32),
    ),
    "untrusted",
  );
  assert.equal(
    clientIp(
      new Headers({
        "x-network-client-ip": "1.2.3.4",
        "x-network-proxy-key": "a".repeat(32),
      }),
      "a".repeat(32),
    ),
    "1.2.3.4",
  );
  const browser = await chromium.launch(),
    context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await login(context, 0, "limit@example.test")).status(),
        401,
      );
    const old = app;
    app = new Application(pool, old.config);
    await old.close();
    assert.equal((await login(context, 0, "limit@example.test")).status(), 429);
    const response = await context.request.post(
      origins[0] + "/api/auth/sign-up/email",
      {
        data: {
          email: "large@example.test",
          password,
          name: "x".repeat(17000),
        },
        headers: { origin: origins[0] },
      },
    );
    assert.equal(response.status(), 413);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P3 provider credentials are encrypted and only safe options are exposed", async () => {
  for (const kind of ["github", "google"] as const)
    await app.auth.providers.set(admin, "atlas", {
      id: kind,
      kind,
      label: kind,
      clientId: "not-a-real-client",
      clientSecret: "PRIVATE-PROVIDER-SECRET",
    });
  const options = await app.auth.publicOptions(
    await app.auth.instance("atlas"),
  );
  assert.deepEqual(
    options.providers.map((p) => p.id),
    ["github", "google"],
  );
  assert.ok(!JSON.stringify(options).includes("PRIVATE"));
  assert.ok(
    !(
      await pool.query("SELECT sealed_config FROM auth_provider LIMIT 1")
    ).rows[0].sealed_config.includes("PRIVATE"),
  );
  await assert.rejects(
    app.auth.providers.set(admin, "notes", {
      id: "github",
      kind: "github",
      label: "GitHub",
      clientId: "a",
      clientSecret: "b",
    }),
  );
});

test("P3 account center lists linked logins and starts explicit provider linking", async () => {
  await app.auth.providers.set(admin, "atlas", {
    id: "github",
    kind: "github",
    label: "GitHub",
    clientId: "not-a-real-client",
    clientSecret: "not-a-real-secret",
  });
  const email = "account-center@example.test";
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const redirect = await anonymous.request.get(origins[0] + "/account", {
        maxRedirects: 0,
      });
      assert.equal(redirect.status(), 303);
      assert.equal(
        redirect.headers().location,
        "/login?returnTo=%2Faccount",
      );
    } finally {
      await anonymous.close();
    }

    await register(context, 0, email);
    await verify(context, email);
    assert.equal((await login(context, 0, email)).status(), 200);

    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(origins[0] + "/account");
    assert.equal(await page.locator("h2").innerText(), "账号设置");
    await page
      .locator("#linked-accounts")
      .getByText("邮箱和密码")
      .waitFor();
    const linkedText = await page.locator("#linked-accounts").innerText();
    assert.ok(linkedText.includes("邮箱和密码"));
    assert.ok(linkedText.includes(email));
    assert.equal(
      await page.locator('[data-provider="github"]').innerText(),
      "绑定 GitHub",
    );

    const initiated = await context.request.post(
      origins[0] + "/api/auth/link-social",
      {
        data: {
          provider: "github",
          callbackURL: origins[0] + "/account",
          disableRedirect: true,
        },
        headers: { origin: origins[0] },
      },
    );
    assert.equal(initiated.status(), 200);
    const linked = await initiated.json();
    assert.ok(linked.url.startsWith("https://github.com/login/oauth/authorize?"));
    assert.ok(
      linked.url.includes(
        "redirect_uri=" +
          encodeURIComponent(origins[0] + "/api/auth/callback/github"),
      ),
    );

    const shared = await context.request.get(origins[1] + "/account", {
      maxRedirects: 0,
    });
    assert.equal(shared.status(), 303);
    assert.equal(shared.headers().location, origins[0] + "/account");

    const accounts = await (
      await context.request.get(origins[0] + "/api/auth/list-accounts")
    ).json();
    const credential = accounts.find(
      (account: { providerId: string }) => account.providerId === "credential",
    );
    assert.ok(credential);
    const unlinked = await context.request.post(
      origins[0] + "/api/auth/unlink-account",
      {
        data: { accountId: credential.id },
        headers: { origin: origins[0] },
      },
    );
    assert.equal(unlinked.status(), 400);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P3 provider checks report the fixed callback and stored status without secrets", async () => {
  const config = {
    id: "github" as const,
    kind: "github" as const,
    label: "GitHub",
    clientId: "check-client",
    clientSecret: "CHECK-PROVIDER-SECRET",
  };
  await app.auth.providers.set(admin, "atlas", config);
  const checked = await app.auth.providers.inspect(admin, "atlas", config);
  assert.equal(checked.callbackUrl, origins[0] + "/api/auth/callback/github");
  assert.deepEqual(checked.existing, { label: "GitHub", enabled: true });
  assert.ok(!JSON.stringify(checked).includes("CHECK-PROVIDER-SECRET"));
  await app.auth.providers.set(admin, "atlas", {
    ...config,
    enabled: false,
  });
  const disabled = await app.auth.providers.inspect(admin, "atlas", config);
  assert.deepEqual(disabled.existing, { label: "GitHub", enabled: false });
  const listed = await app.auth.providers.list(admin, "atlas");
  assert.equal(listed.origin, origins[0]);
  assert.ok(
    listed.providers.some(
      (provider) =>
        provider.id === "github" &&
        provider.enabled === false &&
        provider.callbackUrl === origins[0] + "/api/auth/callback/github",
    ),
  );
  assert.ok(!JSON.stringify(listed).includes("CHECK-PROVIDER-SECRET"));
  const viewerId = await app.sites.operators.create(
    "provider-viewer@example.test",
    "viewer-password-123",
  );
  await app.sites.operators.grant(admin, viewerId, "atlas", "viewer");
  const viewer = await app.sites.operators.current(
    new Headers({
      cookie:
        "network_operator=" +
        (await app.sites.operators.login(
          "provider-viewer@example.test",
          "viewer-password-123",
        )),
    }),
  );
  assert.ok(viewer);
  const viewerList = await app.auth.providers.list(viewer, "atlas");
  assert.ok(viewerList.providers.some((provider) => provider.id === "github"));
  await assert.rejects(
    app.auth.providers.inspect(viewer, "atlas", config),
    /权限/,
  );
  await assert.rejects(
    app.auth.providers.inspect(admin, "atlas", {
      ...config,
      id: "oidc-check",
      kind: "oidc",
      issuer: "http://identity.example.test",
    }),
    /HTTPS/,
  );
  await assert.rejects(
    app.auth.providers.inspect(admin, "notes", config),
    /独立账号中心/,
  );
  await assert.rejects(
    app.auth.providers.inspect(admin, "atlas", {
      ...config,
      id: "google",
    }),
  );
});

test("P3 external HTTPS OIDC authorization validates identity and returns through the standard callback", async () => {
  await app.auth.providers.set(admin, "atlas", {
    id: "oidc-lab",
    kind: "oidc",
    label: "Lab identity",
    clientId: labClient.clientId,
    clientSecret: labClient.clientSecret,
    issuer: labIssuer,
  });
  const browser = await chromium.launch(),
    context = await browser.newContext({ ignoreHTTPSErrors: true }),
    page = await context.newPage();
  page.setDefaultTimeout(10000);
  try {
    const signedIn = await lab.api.signInEmail({
      body: { email: "external-reader@example.test", password },
      asResponse: true,
    });
    const cookies = signedIn.headers.getSetCookie().map((c) => {
      const [name, ...values] = c.split(";")[0].split("=");
      return {
        name,
        value: values.join("="),
        url: origins[2],
        secure: true,
        httpOnly: true,
        sameSite: "Lax" as const,
      };
    });
    await context.addCookies(cookies);
    await page.goto(origins[0] + "/login");
    await page.locator('[data-provider="oidc-lab"]').click();
    await page.waitForURL(origins[0] + "/");
    const session = await (
      await context.request.get(origins[0] + "/api/session")
    ).json();
    assert.equal(session?.email, "external-reader@example.test");
    assert.equal(session.role, "reader");
    await page.goto(origins[1] + "/login");
    await page.locator("button").click();
    await page.waitForURL(origins[1] + "/");
    assert.equal(
      (await (await context.request.get(origins[1] + "/api/session")).json())
        .email,
      session.email,
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P3 explicit provider linking and unlinking works end to end", async () => {
  await app.auth.providers.set(admin, "atlas", {
    id: "oidc-lab",
    kind: "oidc",
    label: "Lab identity",
    clientId: labClient.clientId,
    clientSecret: labClient.clientSecret,
    issuer: labIssuer,
  });
  const email = "linked-reader@example.test";
  await lab.api.signUpEmail({
    body: { email, password, name: "Linked reader" },
  });
  await pool.query('UPDATE lab_user SET "emailVerified"=true WHERE email=$1', [
    email,
  ]);
  const browser = await chromium.launch(),
    context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await register(context, 0, email);
    await verify(context, email);
    assert.equal((await login(context, 0, email)).status(), 200);
    const signedIn = await lab.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    await context.addCookies(
      signedIn.headers.getSetCookie().map((cookie) => {
        const [name, ...values] = cookie.split(";")[0].split("=");
        return {
          name,
          value: values.join("="),
          url: origins[2],
          secure: true,
          httpOnly: true,
          sameSite: "Lax" as const,
        };
      }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(origins[0] + "/account");
    await page.locator('[data-provider="oidc-lab"]').click();
    await page.waitForURL(
      (url) => url.origin === origins[0] && url.pathname === "/account",
    );
    await page.locator("#linked-accounts").getByText("Lab identity").waitFor();
    const accounts = await (
      await context.request.get(origins[0] + "/api/auth/list-accounts")
    ).json();
    assert.ok(
      accounts.some(
        (account: { providerId: string }) =>
          account.providerId === "oidc-lab",
      ),
    );
    page.on("dialog", (dialog) => dialog.accept());
    await page.locator("[data-account]").click();
    await page
      .locator("#linked-accounts")
      .getByText("Lab identity")
      .waitFor({ state: "detached" });
    const after = await (
      await context.request.get(origins[0] + "/api/auth/list-accounts")
    ).json();
    assert.ok(
      !after.some(
        (account: { providerId: string }) =>
          account.providerId === "oidc-lab",
      ),
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P3 session renewal refreshes cookies within the absolute cap; expired sessions cannot be revived", async () => {
  const browser = await chromium.launch(),
    context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await register(context, 0, "renew@example.test");
    await verify(context, "renew@example.test");
    assert.equal((await login(context, 0, "renew@example.test")).status(), 200);
    const canonical = await canonicalSession("atlas", "renew@example.test");
    assert.ok(canonical);
    const instance = await app.auth.instance("atlas"),
      table = prefix(instance);
    const local = (
      await pool.query(
        "SELECT local_session FROM session_bridge WHERE canonical_session=$1",
        [canonical],
      )
    ).rows[0].local_session;
    await pool.query(
      `UPDATE ${table}session SET "expiresAt"=now()+interval '1 day',"updatedAt"=now()-interval '3 days' WHERE id=$1`,
      [local],
    );
    const renewal = await context.request.get(
      origins[0] + "/api/auth/get-session",
    );
    assert.equal(renewal.status(), 200);
    assert.ok(
      renewal.headersArray().some((h) => h.name.toLowerCase() === "set-cookie"),
    );
    const row = (
      await pool.query(
        "SELECT expires_at,absolute_expires_at FROM identity_session WHERE id=$1",
        [canonical],
      )
    ).rows[0];
    assert.ok(row.expires_at.getTime() > Date.now() + 5 * 86400000);
    assert.ok(row.expires_at <= row.absolute_expires_at);
    const identities = new IdentityStore(pool);
    assert.equal(await identities.authorize(canonical, "atlas"), true);
    const relying = await context.newPage();
    await relying.goto(origins[1] + "/login");
    await relying.locator("button").click();
    await relying.waitForURL(origins[1] + "/");
    await pool.query(
      "UPDATE identity_session SET absolute_expires_at=now()-interval '1 second' WHERE id=$1",
      [canonical],
    );
    assert.equal(await identities.authorize(canonical, "atlas"), false);
    assert.equal(
      await (await context.request.get(origins[1] + "/api/session")).json(),
      null,
    );
    const child = await app.auth.instance("notes");
    const authorize = new URL(origins[0] + "/api/auth/oauth2/authorize");
    authorize.search = new URLSearchParams({
      client_id: "site_" + child.id,
      redirect_uri: origins[1] + "/api/auth/callback/network",
      response_type: "code",
      scope: "openid profile email",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      state: "expired-session-check",
    }).toString();
    const expiredAuthorization = await context.request.get(authorize.href, {
      maxRedirects: 0,
    });
    assert.equal(expiredAuthorization.status(), 302);
    assert.ok(expiredAuthorization.headers().location.includes("/login?"));
    const expired = await context.request.get(
      origins[0] + "/api/auth/get-session",
    );
    assert.equal(await expired.json(), null);
    assert.equal(
      await (await context.request.get(origins[0] + "/api/session")).json(),
      null,
    );
    assert.equal(
      (
        await pool.query("SELECT revoked FROM identity_session WHERE id=$1", [
          canonical,
        ])
      ).rows[0].revoked,
      true,
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P3 retention clears old revoked bridges while preserving users and recent history", async () => {
  const row = (
    await pool.query(
      "SELECT id,user_id FROM identity_session WHERE revoked ORDER BY created_at LIMIT 1",
    )
  ).rows[0];
  assert.ok(row);
  await pool.query(
    "UPDATE identity_session SET revoked_at=now()-interval '31 days' WHERE id=$1",
    [row.id],
  );
  await app.auth.maintain();
  assert.equal(
    (await pool.query("SELECT 1 FROM identity_session WHERE id=$1", [row.id]))
      .rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM session_bridge WHERE canonical_session=$1",
        [row.id],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (await pool.query("SELECT 1 FROM identity_user WHERE id=$1", [row.user_id]))
      .rowCount,
    1,
  );
});

test("P3 OIDC callbacks reject forged state and existing email identities cannot be silently linked", async () => {
  const browser = await chromium.launch(),
    context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const response = await context.request.get(
      origins[0] + "/api/auth/callback/oidc-lab?code=forged&state=forged",
    );
    assert.ok(
      response.status() >= 400 ||
        new URL(response.url()).searchParams.has("error"),
    );
    assert.equal(
      await (await context.request.get(origins[0] + "/api/session")).json(),
      null,
    );
    await register(context, 0, "collision@example.test");
    await verify(context, "collision@example.test");
    const signup = await lab.handler(
      new Request(labIssuer + "/sign-up/email", {
        method: "POST",
        headers: { origin: origins[2], "content-type": "application/json" },
        body: JSON.stringify({
          email: "collision@example.test",
          password,
          name: "Different external identity",
        }),
      }),
    );
    assert.equal(signup.status, 200);
    await pool.query(
      'UPDATE lab_user SET "emailVerified"=true WHERE email=$1',
      ["collision@example.test"],
    );
    const signed = await lab.api.signInEmail({
      body: { email: "collision@example.test", password },
      asResponse: true,
    });
    await context.addCookies(
      signed.headers.getSetCookie().map((c) => {
        const [name, ...values] = c.split(";")[0].split("=");
        return {
          name,
          value: values.join("="),
          url: origins[2],
          secure: true,
          httpOnly: true,
          sameSite: "Lax" as const,
        };
      }),
    );
    const page = await context.newPage();
    await page.goto(origins[0] + "/login");
    await page.locator('[data-provider="oidc-lab"]').click();
    await page.waitForURL(
      (url) => url.origin === origins[0] && url.searchParams.has("error"),
    );
    assert.equal(
      await (await context.request.get(origins[0] + "/api/session")).json(),
      null,
    );
    const instance = await app.auth.instance("atlas");
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM ${prefix(instance)}user WHERE email=$1`,
          ["collision@example.test"],
        )
      ).rows[0].n,
      1,
    );
    await assert.rejects(
      app.auth.providers.set(admin, "atlas", {
        id: "oidc-unsafe",
        kind: "oidc",
        label: "Unsafe",
        clientId: "a",
        clientSecret: "b",
        issuer: "http://example.test",
      }),
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P3 templates and account pages fit mobile screens, and provider labels cannot break embedded JSON", async () => {
  await app.auth.providers.set(admin, "atlas", {
    id: "github",
    kind: "github",
    label: "GitHub </script><script>injected</script>",
    clientId: "dummy",
    clientSecret: "dummy",
  });
  const browser = await chromium.launch(),
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
    }),
    page = await context.newPage();
  try {
    await page.goto(origins[0] + "/login");
    assert.equal(
      await page.locator('[data-provider="github"]').textContent(),
      "通过 GitHub </script><script>injected</script> 登录",
    );
    assert.equal(await page.locator("script").count(), 2);
    assert.equal(
      await page
        .locator("#account-options")
        .evaluate((node) => JSON.parse(node.textContent!).providers[0].label),
      "GitHub </script><script>injected</script>",
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: ".local/p3-account-mobile.png",
      fullPage: true,
    });
    await page.goto(origins[0] + "/");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: ".local/p3-editorial-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await page.screenshot({
      path: ".local/p3-editorial-desktop.png",
      fullPage: true,
    });
    assert.equal(
      (await context.request.get(origins[1] + "/reset-password")).url(),
      origins[1] + "/login",
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P3 SMTP retries recover and stale worker leases cannot lose a queued mail", async () => {
  await pool.query(
    "UPDATE mail_queue SET expires_at=now()-interval '1 second' WHERE status='pending'",
  );
  await app.auth.mail.runOnce();
  const before = smtp.messages.length;
  await app.auth.mail.enqueue(
    "atlas",
    origins[0],
    "reset",
    "lease@example.test",
    origins[0] + "/api/auth/reset-password/test",
  );
  const row = (
    await pool.query(
      "SELECT id FROM mail_queue WHERE status='pending' ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0];
  await pool.query(
    "UPDATE mail_queue SET status='processing',lease_until=now()-interval '1 second',lease_token=gen_random_uuid(),attempts=1 WHERE id=$1",
    [row.id],
  );
  await app.auth.mail.runOnce();
  assert.equal(smtp.messages.length, before + 1);
  assert.equal(
    (
      await pool.query("SELECT status,payload FROM mail_queue WHERE id=$1", [
        row.id,
      ])
    ).rows[0].status,
    "done",
  );
  await app.auth.mail.enqueue(
    "atlas",
    origins[0],
    "reset",
    "fail@example.test",
    origins[0] + "/api/auth/reset-password/test",
  );
  const failed = (
    await pool.query(
      "SELECT id FROM mail_queue WHERE status='pending' ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0];
  await pool.query("UPDATE mail_queue SET attempts=4 WHERE id=$1", [failed.id]);
  await new MailQueue(pool, key, { ...policy.smtp!, port: 1 }).runOnce();
  assert.deepEqual(
    (
      await pool.query("SELECT status,payload FROM mail_queue WHERE id=$1", [
        failed.id,
      ])
    ).rows[0],
    { status: "failed", payload: null },
  );
});

test("P3 shared-site authorization resumes after external login at the account center", async () => {
  const browser = await chromium.launch(),
    context = await browser.newContext({ ignoreHTTPSErrors: true }),
    page = await context.newPage();
  page.setDefaultTimeout(10000);
  try {
    const signed = await lab.api.signInEmail({
      body: { email: "external-reader@example.test", password },
      asResponse: true,
    });
    await context.addCookies(
      signed.headers.getSetCookie().map((c) => {
        const [name, ...values] = c.split(";")[0].split("=");
        return {
          name,
          value: values.join("="),
          url: origins[2],
          secure: true,
          httpOnly: true,
          sameSite: "Lax" as const,
        };
      }),
    );
    await page.goto(origins[1] + "/login");
    await page.locator("button").click();
    await page.waitForURL(origins[0] + "/login?**");
    await page.locator('[data-provider="oidc-lab"]').click();
    await page.waitForURL(origins[1] + "/");
    assert.equal(
      (await (await context.request.get(origins[1] + "/api/session")).json())
        .email,
      "external-reader@example.test",
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P3 GitHub and Google login initiation uses fixed provider URLs and registered center callbacks", async () => {
  const browser = await chromium.launch(),
    context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    for (const [provider, hostname] of [
      ["github", "github.com"],
      ["google", "accounts.google.com"],
    ]) {
      const response = await context.request.post(
        origins[0] + "/api/auth/sign-in/social",
        {
          headers: { origin: origins[0] },
          data: { provider, callbackURL: origins[0] + "/" },
        },
      );
      assert.equal(response.status(), 200);
      const authorization = new URL((await response.json()).url);
      assert.equal(authorization.protocol, "https:");
      assert.equal(authorization.hostname, hostname);
      assert.equal(
        authorization.searchParams.get("redirect_uri"),
        origins[0] + "/api/auth/callback/" + provider,
      );
      assert.ok(authorization.searchParams.get("state"));
    }
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P3 mail policy rejects misspelled verification flags and partial SMTP credentials", () => {
  assert.throws(() => authPolicy({ AUTH_REQUIRE_EMAIL: "treu" }));
  assert.throws(() => authPolicy({ AUTH_REQUIRE_EMAIL: "true" }));
  assert.throws(() =>
    authPolicy({
      SMTP_HOST: "smtp.example.test",
      MAIL_FROM: "accounts@example.test",
      SMTP_USER: "only-user",
    }),
  );
  assert.throws(() =>
    authPolicy({
      SMTP_HOST: "smtp.example.test",
      MAIL_FROM: "accounts@example.test",
      SMTP_ALLOW_INSECURE: "true",
    }),
  );
  assert.equal(authPolicy({}).requireEmail, false);
  const smtp = {
    SMTP_HOST: "smtp.example.test",
    MAIL_FROM: "accounts@example.test",
  };
  assert.throws(
    () => authPolicy({ NODE_ENV: "production", ...smtp }),
    /PROXY_TRUST_TOKEN/,
  );
  assert.throws(
    () => authPolicy({ NODE_ENV: "production" }),
    /Email verification requires configured SMTP/,
  );
  assert.throws(
    () =>
      authPolicy({
        NODE_ENV: "production",
        AUTH_REQUIRE_EMAIL: "false",
      }),
    /PROXY_TRUST_TOKEN/,
  );
  assert.equal(
    authPolicy({
      NODE_ENV: "production",
      AUTH_REQUIRE_EMAIL: "false",
      PROXY_TRUST_TOKEN: "x".repeat(32),
    }).requireEmail,
    false,
  );
});

test("P3 generic OIDC preserves exact trailing-slash issuers and accepts standard client authentication choices", async () => {
  assert.equal(
    oidcDiscovery("https://identity.example.test/realm/"),
    "https://identity.example.test/realm/.well-known/openid-configuration",
  );
  assert.equal(
    oidcDiscovery("https://identity.example.test/"),
    "https://identity.example.test/.well-known/openid-configuration",
  );
  await app.auth.providers.set(admin, "atlas", {
    id: "oidc-trailing",
    kind: "oidc",
    label: "Disabled issuer fixture",
    clientId: "fixture",
    clientSecret: "fixture",
    issuer: "https://identity.example.test/realm/",
    authentication: "basic",
    enabled: false,
  });
  const row = (
    await pool.query(
      "SELECT sealed_config FROM auth_provider WHERE id='oidc-trailing'",
    )
  ).rows[0];
  const config = unseal<{ issuer: string; authentication: string }>(
    row.sealed_config,
    key,
  );
  assert.equal(config.issuer, "https://identity.example.test/realm/");
  assert.equal(config.authentication, "basic");
});

test("P3 reauthentication replaces an invalid canonical session without clearing the newly issued cookie", async () => {
  const browser = await chromium.launch(),
    context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await register(context, 0, "reauth@example.test");
    await verify(context, "reauth@example.test");
    assert.equal(
      (await login(context, 0, "reauth@example.test")).status(),
      200,
    );
    for (const expiry of ["revoked", "absolute"]) {
      const previousId = await canonicalSession(
        "atlas",
        "reauth@example.test",
      );
      assert.ok(previousId);
      if (expiry === "revoked")
        await pool.query(
          "UPDATE identity_session SET revoked=true WHERE id=$1",
          [previousId],
        );
      else
        await pool.query(
          "UPDATE identity_session SET absolute_expires_at=now()-interval '1 second' WHERE id=$1",
          [previousId],
        );
      const result = await login(context, 0, "reauth@example.test");
      assert.equal(result.status(), 200);
      const current = await (
        await context.request.get(origins[0] + "/api/session")
      ).json();
      assert.equal(current?.email, "reauth@example.test");
      const currentId = await canonicalSession("atlas", "reauth@example.test");
      assert.ok(currentId, "fresh cookie must survive " + expiry + " cleanup");
      assert.notEqual(currentId, previousId);
    }
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P3 an OAuth callback preserves its state when the old canonical session expires during provider authorization", async () => {
  const browser = await chromium.launch(),
    context = await browser.newContext({ ignoreHTTPSErrors: true }),
    page = await context.newPage();
  page.setDefaultTimeout(10000);
  try {
    await register(context, 0, "callback-expiry@example.test");
    await verify(context, "callback-expiry@example.test");
    await login(context, 0, "callback-expiry@example.test");
    const old = await (
      await context.request.get(origins[0] + "/api/session")
    ).json();
    const signed = await lab.api.signInEmail({
      body: { email: "external-reader@example.test", password },
      asResponse: true,
    });
    await context.addCookies(
      signed.headers.getSetCookie().map((c) => {
        const [name, ...values] = c.split(";")[0].split("=");
        return {
          name,
          value: values.join("="),
          url: origins[2],
          secure: true,
          httpOnly: true,
          sameSite: "Lax" as const,
        };
      }),
    );
    const start = await context.request.post(
      origins[0] + "/api/auth/sign-in/social",
      {
        headers: { origin: origins[0] },
        data: { provider: "oidc-lab", callbackURL: origins[0] + "/" },
      },
    );
    assert.equal(start.status(), 200);
    await pool.query(
      "UPDATE identity_session SET absolute_expires_at=now()-interval '1 second' WHERE id=$1",
      [old.id],
    );
    await page.goto((await start.json()).url);
    await page.waitForURL(origins[0] + "/");
    assert.equal(
      (await (await context.request.get(origins[0] + "/api/session")).json())
        .email,
      "external-reader@example.test",
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

// Browser ordering fixtures use real account markup/script, not signed OAuth verification.
async function accountReviewBrowser() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.route("**/login**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: accountPage("Account review", false, "/login", {
        mail: true,
        requireEmail: false,
        providers: [],
      }),
    }),
  );
  await page.route("**/api/session", (route) => route.fulfill({ json: null }));
  await page.route("**/old-user-landing", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "Old account destination",
    }),
  );
  return {
    page,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}
async function accountReviewFrame(page: import("@playwright/test").Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function accountReviewCredentials(page: import("@playwright/test").Page) {
  await page.locator("#email").fill("chosen-account@example.test");
  await page.locator("#password").fill("Account-review-password!");
}

test("account review: delayed session lookup cannot resume the old account after manual login", async () => {
  const { page, close } = await accountReviewBrowser();
  let release!: () => void,
    entered!: () => void,
    continuations = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    await page.route("**/api/session", async (route) => {
      entered();
      await held;
      await route.fulfill({ json: { email: "old-user@example.test", role: "reader" } });
    });
    await page.route("**/api/auth/oauth2/continue", (route) => {
      continuations++;
      return route.fulfill({
        json: { redirect_uri: origins[0] + "/old-user-landing" },
      });
    });
    await page.route("**/api/auth/sign-in/email", (route) =>
      route.fulfill({ status: 401, json: { message: "Chosen login failed" } }),
    );
    await page.goto(origins[0] + "/login?sig=review-signature");
    await started;
    await accountReviewCredentials(page);
    await page
      .locator(
        '#public-login button[type="submit"], #public-login button:not([type])',
      )
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent ===
        "Chosen login failed",
    );
    const finished = page.waitForResponse((r) =>
      r.url().endsWith("/api/session"),
    );
    release();
    await (await finished).finished();
    await accountReviewFrame(page);
    assert.equal(continuations, 0);
    assert.equal(new URL(page.url()).pathname, "/login");
    assert.equal(
      await page.locator("#message").innerText(),
      "Chosen login failed",
    );
  } finally {
    release();
    await close();
  }
});

for (const status of [200, 503])
  test(`account review: automatic ${status} continuation cannot override a manual attempt`, async () => {
    const { page, close } = await accountReviewBrowser();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      await page.route("**/api/session", (route) =>
        route.fulfill({ json: { email: "old-user@example.test", role: "reader" } }),
      );
      await page.route("**/api/auth/oauth2/continue", async (route) => {
        entered();
        await held;
        await route.fulfill({
          status,
          json:
            status === 200
              ? { redirect_uri: origins[0] + "/old-user-landing" }
              : { message: "Old continuation failed" },
        });
      });
      await page.route("**/api/auth/sign-in/email", (route) =>
        route.fulfill({
          status: 401,
          json: { message: "Manual login failed" },
        }),
      );
      await page.goto(origins[0] + "/login?sig=review-signature");
      await started;
      await accountReviewCredentials(page);
      await page.locator("#public-login button:not([type])").click();
      await page.waitForFunction(
        () =>
          document.querySelector("#message")?.textContent ===
          "Manual login failed",
      );
      const finished = page.waitForResponse((r) =>
        r.url().endsWith("/api/auth/oauth2/continue"),
      );
      release();
      await (await finished).finished();
      await accountReviewFrame(page);
      assert.equal(new URL(page.url()).pathname, "/login");
      assert.equal(
        await page.locator("#message").innerText(),
        "Manual login failed",
      );
    } finally {
      release();
      await close();
    }
  });

test("account review: unavailable session lookup does not start OAuth continuation", async () => {
  const { page, close } = await accountReviewBrowser();
  let continuations = 0;
  try {
    await page.route("**/api/session", (route) =>
      route.fulfill({ status: 503, json: { error: "Session unavailable" } }),
    );
    await page.route("**/api/auth/oauth2/continue", (route) => {
      continuations++;
      return route.fulfill({
        status: 401,
        json: { message: "Should not have continued" },
      });
    });
    const finished = page.waitForResponse((r) =>
      r.url().endsWith("/api/session"),
    );
    await page.goto(origins[0] + "/login?sig=review-signature");
    await (await finished).finished();
    await accountReviewFrame(page);
    assert.equal(continuations, 0);
    assert.equal(await page.locator("#message").innerText(), "");
  } finally {
    await close();
  }
});

test("account review: repeated form submits send only one pending authentication request", async () => {
  const { page, close } = await accountReviewBrowser();
  let release!: () => void,
    entered!: () => void,
    posts = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    await page.route("**/api/auth/sign-in/email", async (route) => {
      posts++;
      entered();
      await held;
      await route.fulfill({ status: 401, json: { message: "Try again" } });
    });
    await page.goto(origins[0] + "/login");
    await accountReviewCredentials(page);
    await page.locator("#public-login").evaluate((form) => {
      (form as HTMLFormElement).requestSubmit();
      (form as HTMLFormElement).requestSubmit();
    });
    await started;
    await accountReviewFrame(page);
    assert.equal(posts, 1);
    release();
    await page.waitForFunction(
      () =>
        !(document.querySelector("#public-login button") as HTMLButtonElement)
          .disabled,
    );
    await page.locator("#public-login button:not([type])").click();
    await page.waitForFunction(
      () =>
        !(document.querySelector("#public-login button") as HTMLButtonElement)
          .disabled,
    );
    assert.equal(posts, 2);
  } finally {
    release();
    await close();
  }
});

const accountUnconfirmed =
  "未能确认操作结果，请先核对邮件或登录状态，避免重复提交。";
async function accountResponseBrowser(
  path = "/login",
  options: Partial<Parameters<typeof accountPage>[3]> = {},
) {
  const f = await accountReviewBrowser();
  const pathname = new URL(path, origins[0]).pathname;
  await f.page.route(origins[0] + pathname + "*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: accountPage("Account response", false, pathname, {
        mail: true,
        requireEmail: false,
        providers: [],
        ...options,
      }),
    }),
  );
  return { ...f, open: () => f.page.goto(origins[0] + path) };
}
for (const failure of ["html", "null"])
  test(`account response review: ${failure} HTTP error preserves credentials and allows retry`, async () => {
    const f = await accountResponseBrowser();
    let posts = 0;
    try {
      await f.page.route("**/api/auth/sign-in/email", (route) => {
        posts++;
        return route.fulfill(
          posts === 1
            ? failure === "html"
              ? {
                  status: 503,
                  contentType: "text/html",
                  body: "<h1>Proxy unavailable</h1>",
                }
              : { status: 503, json: null }
            : {
                status: 401,
                json: { message: "Retry reached authentication" },
              },
        );
      });
      await f.open();
      await accountReviewCredentials(f.page);
      await f.page.locator("#public-login button:not([type])").click();
      await f.page.waitForFunction(
        () =>
          !(document.querySelector("#public-login button") as HTMLButtonElement)
            .disabled,
      );
      assert.equal(
        await f.page.locator("#message").innerText(),
        "操作失败（HTTP 503），请稍后重试。",
      );
      assert.equal(
        await f.page.locator("#email").inputValue(),
        "chosen-account@example.test",
      );
      assert.equal(
        await f.page.locator("#password").inputValue(),
        "Account-review-password!",
      );
      await f.page.locator("#public-login button:not([type])").click();
      await f.page.waitForFunction(
        () =>
          document.querySelector("#message")?.textContent ===
          "Retry reached authentication",
      );
      assert.equal(posts, 2);
    } finally {
      await f.close();
    }
  });

test("account response review: structured message falls back to textual error", async () => {
  const f = await accountResponseBrowser();
  try {
    await f.page.route("**/api/auth/sign-in/email", (route) =>
      route.fulfill({
        status: 503,
        json: { message: { code: "UNAVAILABLE" }, error: "认证暂不可用" },
      }),
    );
    await f.open();
    await accountReviewCredentials(f.page);
    await f.page.locator("#public-login button:not([type])").click();
    await f.page.waitForFunction(
      () =>
        !(document.querySelector("#public-login button") as HTMLButtonElement)
          .disabled,
    );
    assert.equal(await f.page.locator("#message").innerText(), "认证暂不可用");
  } finally {
    await f.close();
  }
});
for (const payload of [null, { status: false }])
  test(`account response review: reset mail ${JSON.stringify(payload)} is not acknowledged`, async () => {
    const f = await accountResponseBrowser("/forgot-password");
    let posts = 0;
    try {
      await f.page.route("**/api/auth/request-password-reset", (route) => {
        posts++;
        return route.fulfill({
          json: posts === 1 ? payload : { status: true },
        });
      });
      await f.open();
      await f.page.locator("#email").fill("chosen-account@example.test");
      await f.page.locator("#public-login button").click();
      await f.page.waitForFunction(
        () =>
          !(document.querySelector("#public-login button") as HTMLButtonElement)
            .disabled,
      );
      assert.equal(
        await f.page.locator("#message").innerText(),
        accountUnconfirmed,
      );
      assert.equal(
        await f.page.locator("#email").inputValue(),
        "chosen-account@example.test",
      );
      await accountReviewFrame(f.page);
      assert.equal(posts, 1);
      await f.page.locator("#public-login button").click();
      await f.page.waitForFunction(
        () =>
          document.querySelector("#message")?.textContent ===
          "如果该邮箱已注册，我们会发送重置邮件。请检查收件箱。",
      );
      assert.equal(posts, 2);
    } finally {
      await f.close();
    }
  });

test("account response review: damaged reset result keeps token and password until explicit confirmed retry", async () => {
  const f = await accountResponseBrowser(
    "/reset-password?token=response-token",
  );
  let posts = 0;
  try {
    await f.page.route("**/api/auth/reset-password", (route) => {
      posts++;
      assert.deepEqual(route.request().postDataJSON(), {
        token: "response-token",
        newPassword: "Account-review-password!",
      });
      return route.fulfill(
        posts === 1
          ? { status: 200, contentType: "application/json", body: '{"status":' }
          : { json: { status: true } },
      );
    });
    await f.open();
    await f.page.locator("#password").fill("Account-review-password!");
    await f.page.locator("#public-login button").click();
    await f.page.waitForFunction(
      () =>
        !(document.querySelector("#public-login button") as HTMLButtonElement)
          .disabled,
    );
    assert.equal(
      await f.page.locator("#message").innerText(),
      accountUnconfirmed,
    );
    assert.equal(
      new URL(f.page.url()).searchParams.get("token"),
      "response-token",
    );
    assert.equal(
      await f.page.locator("#password").inputValue(),
      "Account-review-password!",
    );
    assert.equal(posts, 1);
    await f.page.locator("#public-login button").click();
    await f.page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.startsWith("密码已更新"),
    );
    assert.equal(new URL(f.page.url()).search, "");
    assert.equal(posts, 2);
  } finally {
    await f.close();
  }
});

test("account response review: null registration is not treated as email confirmation", async () => {
  const f = await accountResponseBrowser("/login", { requireEmail: true });
  try {
    await f.page.route("**/api/auth/sign-up/email", (route) =>
      route.fulfill({ json: null }),
    );
    await f.open();
    await accountReviewCredentials(f.page);
    await f.page.locator("#register").click();
    await f.page.waitForFunction(
      () =>
        !(document.querySelector("#register") as HTMLButtonElement).disabled,
    );
    assert.equal(
      await f.page.locator("#message").innerText(),
      accountUnconfirmed,
    );
    assert.equal(new URL(f.page.url()).pathname, "/login");
  } finally {
    await f.close();
  }
});

test("account response review: provider response without URL cannot navigate", async () => {
  const f = await accountResponseBrowser("/login", {
    providers: [{ id: "github", label: "GitHub", kind: "github" }],
  });
  let posts = 0;
  try {
    await f.page.route("**/api/auth/sign-in/social", (route) => {
      posts++;
      return route.fulfill({
        json:
          posts === 1
            ? { redirect: true }
            : { redirect: true, url: origins[0] + "/old-user-landing" },
      });
    });
    await f.page.route(origins[0] + "/undefined", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<p>Incorrect destination</p>",
      }),
    );
    await f.open();
    await f.page.locator('[data-provider="github"]').click();
    await f.page.waitForFunction(
      () =>
        !!document.querySelector("#message")?.textContent ||
        location.pathname === "/undefined",
    );
    assert.equal(new URL(f.page.url()).pathname, "/login");
    assert.equal(
      await f.page.locator("#message").innerText(),
      accountUnconfirmed,
    );
    assert.equal(
      await f.page.locator('[data-provider="github"]').isEnabled(),
      true,
    );
    assert.equal(posts, 1);
    await f.page.locator('[data-provider="github"]').click();
    await f.page.waitForURL(origins[0] + "/old-user-landing");
    assert.equal(posts, 2);
  } finally {
    await f.close();
  }
});

for (const action of ["login", "register"])
  test(`account response review: empty ${action} result is not a confirmation`, async () => {
    const f = await accountResponseBrowser(
      "/login?returnTo=%2Fold-user-landing",
      { requireEmail: true },
    );
    let posts = 0;
    try {
      await f.page.route(
        action === "login"
          ? "**/api/auth/sign-in/email"
          : "**/api/auth/sign-up/email",
        (route) => {
          posts++;
          return route.fulfill({
            json:
              posts === 1
                ? {}
                : action === "login"
                  ? { token: "confirmed-token", user: { id: "reader" } }
                  : { token: null, user: { id: "pending-reader" } },
          });
        },
      );
      await f.open();
      await accountReviewCredentials(f.page);
      const button = f.page.locator(
        action === "login" ? "#public-login button:not([type])" : "#register",
      );
      await button.click();
      await f.page.waitForFunction(
        () =>
          !!document.querySelector("#message")?.textContent ||
          location.pathname === "/old-user-landing",
      );
      assert.equal(new URL(f.page.url()).pathname, "/login");
      assert.equal(
        await f.page.locator("#message").innerText(),
        accountUnconfirmed,
      );
      assert.equal(posts, 1);
      await button.click();
      if (action === "login")
        await f.page.waitForURL(origins[0] + "/old-user-landing");
      else
        await f.page.waitForFunction(
          () =>
            document.querySelector("#message")?.textContent ===
            "注册请求已收到，请验证邮箱后回到此页登录。",
        );
      assert.equal(posts, 2);
    } finally {
      await f.close();
    }
  });
