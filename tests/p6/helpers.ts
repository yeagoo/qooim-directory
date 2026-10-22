import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { chromium, type Page } from "@playwright/test";
import { database } from "../../p0/tests/database.js";
import { migrate } from "../../src/server/migrate.js";
import { Application } from "../../src/server/http.js";
import type { Operator } from "../../src/server/operators.js";

export const password = "P6-test-password-431!";
export type Fixture = {
  pool: Pool;
  app: Application;
  admin: Operator;
  editor: Operator;
  viewer: Operator;
  mediaRoot: string;
  key: string;
  // Calls the admin API in-process with the global administrator's session.
  api: (path: string, init?: { method?: string; body?: unknown }) => Promise<Response>;
  // Opens the admin console in Chromium, serving every request in-process.
  browse: (
    operator: Operator,
    hash: string,
  ) => Promise<{ page: Page; close: () => Promise<void> }>;
  close: () => Promise<void>;
};
// Sites: atlas (editor has write, viewer has read) and notes (no grants).
export async function setup(): Promise<Fixture> {
  const pool = await database();
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await migrate(pool);
  const mediaRoot = await mkdtemp(join(tmpdir(), "p6-media-"));
  const key = randomBytes(32).toString("hex");
  const origins = ["atlas", "notes", "admin"].map(
    (name) => `https://${name}.p6.test`,
  );
  const app = new Application(pool, {
    key,
    adminOrigin: origins[2],
    databaseUrl: process.env.P0_DATABASE_URL!,
    development: false,
    mediaRoot,
  });
  const adminId = await app.sites.operators.create(
    "owner@example.test",
    password,
    true,
  );
  const admin = { id: adminId, email: "owner@example.test", global_admin: true };
  const editorId = await app.sites.operators.create("editor@example.test", password);
  const editor = { id: editorId, email: "editor@example.test", global_admin: false };
  const viewerId = await app.sites.operators.create("viewer@example.test", password);
  const viewer = { id: viewerId, email: "viewer@example.test", global_admin: false };
  for (const [index, id] of ["atlas", "notes"].entries())
    await app.sites.create(admin, {
      id,
      name: id,
      origin: origins[index],
      centerSite: null,
    });
  await app.sites.operators.grant(admin, editorId, "atlas", "editor");
  await app.sites.operators.grant(admin, viewerId, "atlas", "viewer");
  const cookie =
    "network_operator=" + (await app.sites.operators.login(admin.email, password));
  const api: Fixture["api"] = (path, init = {}) =>
    app.respond(
      new Request(origins[2] + "/admin/api" + path, {
        method: init.method ?? "GET",
        headers: {
          host: new URL(origins[2]).host,
          cookie,
          origin: origins[2],
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
  const browse: Fixture["browse"] = async (operator, hash) => {
    const token = await app.sites.operators.login(operator.email, password);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const body = request.postDataBuffer();
      const response = await app.respond(
        new Request(url, {
          method: request.method(),
          headers: {
            ...(await request.allHeaders()),
            host: url.host,
            cookie: "network_operator=" + token,
          },
          ...(body ? { body: new Uint8Array(body) } : {}),
        }),
      );
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    await page.goto(origins[2] + "/admin" + hash);
    return { page, close: () => browser.close() };
  };
  return {
    pool,
    app,
    admin,
    editor,
    viewer,
    mediaRoot,
    key,
    api,
    browse,
    close: async () => {
      await app.close();
      await pool.end();
      await rm(mediaRoot, { recursive: true, force: true });
    },
  };
}
