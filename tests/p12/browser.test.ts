// Browser behaviour of the toolso template: /assets/toolso.js (+ toolso-init.js, directory.js)
// against the in-process application, plus the SEO head/JSON-LD built by lib/seo.ts.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { detail as detailFixture, home as homeFixture } from "../../fixtures/templates/directory.js";
import { detailSeo, homeSeo } from "../../src/templates/toolso/lib/seo.js";
import { setup, type Fixture } from "../p6/helpers.js";
import { get, seedToolso } from "./helpers.js";

// lib/seo.ts runs while <Document>'s props are built, before Document installs the render
// context. Evaluated at import time, before anything in this process has rendered a page:
// calling context()/translator() here would throw.
const early = (() => {
  try {
    return { home: homeSeo(homeFixture), detail: detailSeo(detailFixture) };
  } catch (error) {
    return { error };
  }
})();

const ORIGIN = "https://atlas.p6.test";
let f: Fixture;
let browser: Browser;
before(async () => {
  f = await setup();
  await seedToolso(f);
  // The worker provisions each site's account service in production; directory.js and the
  // session menu call /api/auth/* and /api/session on every page.
  assert.equal(await f.app.auth.provision("atlas"), true);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await f?.close();
});

type Session = {
  context: BrowserContext;
  page: Page;
  errors: string[];
  statuses: Map<string, number>;
  close: () => Promise<void>;
};
/** A fresh context whose every request is answered in-process by the application (public host). */
async function open(path: string, options: { clipboard?: boolean } = {}): Promise<Session> {
  const context = await browser.newContext();
  if (options.clipboard)
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataBuffer();
    const response = await f.app.respond(
      new Request(url, {
        method: request.method(),
        headers: { ...(await request.allHeaders()), host: url.host },
        ...(body ? { body: new Uint8Array(body) } : {}),
      }),
    );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  const statuses = new Map<string, number>();
  // CSP violations are reported as console errors ("Refused to ...").
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("response", (response) => statuses.set(new URL(response.url()).pathname, response.status()));
  await page.goto(ORIGIN + path);
  // Not "networkidle": directory.js never reads its /api/auth/get-session body, and with request
  // interception Chromium then never reports that request as finished.
  await page.waitForLoadState("load");
  await page.waitForTimeout(300);
  return { context, page, errors, statuses, close: () => context.close() };
}
const message = (page: Page) => page.locator("#message");

test("P12 SEO helpers work before <Document> installs the render context", () => {
  assert.ok(!("error" in early), `lib/seo threw: ${"error" in early ? String(early.error) : ""}`);
  const { home, detail } = early as Exclude<typeof early, { error: unknown }>;
  assert.equal(home.title, "为好奇心整理入口。精选工具、开放知识与独立创作。 · 拾光目录");
  assert.deepEqual(
    home.jsonLd?.map((d) => (d as { "@type": string })["@type"]),
    ["WebSite", "Organization"],
  );
  assert.equal(detail.title, "开放知识书房 · 拾光目录");
  const breadcrumb = detail.jsonLd?.find((d) => (d as { "@type": string })["@type"] === "BreadcrumbList") as {
    itemListElement: { name: string; item: string }[];
  };
  assert.deepEqual(
    breadcrumb.itemListElement.map((c) => c.name),
    ["首页", "全部产品", "阅读与知识", "开放知识书房"],
  );
});

test("P12 SEO head: titles and JSON-LD per page kind, from real data only", async () => {
  const jsonLd = (body: string) =>
    [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
      ([, json]) => JSON.parse(json!) as Record<string, unknown> & { "@type": string },
    );
  const page = async (path: string) => {
    const body = await (await get(f, path)).text();
    return { body, title: body.match(/<title>([^<]*)<\/title>/)?.[1], ld: jsonLd(body) };
  };

  const home = await page("/");
  assert.equal(home.title, "发现好用的工具 · Atlas 工具");
  assert.match(home.body, /<meta name="description" content="发现好用的工具"/);
  const site = home.ld.find((d) => d["@type"] === "WebSite") as Record<string, any>;
  assert.equal(site.url, `${ORIGIN}/`);
  assert.equal(site.inLanguage, "zh-CN");
  assert.equal(site.potentialAction.target.urlTemplate, `${ORIGIN}/zh/tools?q={search_term_string}`);
  assert.deepEqual(home.ld.find((d) => d["@type"] === "Organization"), {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Atlas 工具",
    url: `${ORIGIN}/`,
  });
  const en = await page("/en");
  assert.equal((en.ld.find((d) => d["@type"] === "WebSite") as Record<string, any>).inLanguage, "en-US");
  assert.equal((en.ld.find((d) => d["@type"] === "WebSite") as Record<string, any>).url, `${ORIGIN}/en`);

  const catalog = await page("/zh/tools");
  assert.equal(catalog.title, "全部产品 · Atlas 工具");
  const list = catalog.ld.find((d) => d["@type"] === "ItemList") as Record<string, any>;
  assert.ok(list.itemListElement.some((e: { url: string }) => e.url === `${ORIGIN}/zh/tools/figma`));
  assert.equal(catalog.ld.some((d) => d["@type"] === "BreadcrumbList"), false);

  const category = await page("/zh/tools/category/design");
  assert.equal(category.title, "设计 · 浏览 设计 工具 · Atlas 工具");
  assert.deepEqual(
    (category.ld.find((d) => d["@type"] === "BreadcrumbList") as Record<string, any>).itemListElement.map(
      (c: { name: string; item: string }) => [c.name, c.item],
    ),
    [
      ["首页", `${ORIGIN}/`],
      ["全部产品", `${ORIGIN}/zh/tools`],
      ["设计", `${ORIGIN}/zh/tools/category/design`],
    ],
  );
  const items = (category.ld.find((d) => d["@type"] === "ItemList") as Record<string, any>).itemListElement;
  assert.deepEqual(
    items.map((e: { url: string }) => e.url).sort(),
    [`${ORIGIN}/zh/tools/figma`, `${ORIGIN}/zh/tools/penpot`],
  );

  const detail = await page("/zh/tools/figma");
  assert.equal(detail.title, "Figma - 全部产品 · Atlas 工具");
  assert.deepEqual(detail.ld.find((d) => d["@type"] === "SoftwareApplication"), {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Figma",
    description: "Figma 的中文介绍",
    url: "https://example.com/figma",
    applicationSubCategory: "设计",
  });
  assert.deepEqual(
    (detail.ld.find((d) => d["@type"] === "BreadcrumbList") as Record<string, any>).itemListElement.map(
      (c: { name: string }) => c.name,
    ),
    ["首页", "全部产品", "设计", "Figma"],
  );
  assert.equal((await page("/en/tools/figma")).title, "Figma - All Tools · Atlas 工具");

  const missing = await page("/zh/tools/does-not-exist");
  assert.equal(missing.ld.length, 0);
});

test("P12 home loads cleanly: no console errors or CSP violations, CSS and fonts load", async () => {
  const s = await open("/");
  try {
    await s.page.evaluate(() => document.fonts.ready);
    assert.deepEqual(s.errors, []);
    assert.equal(s.statuses.get("/assets/toolso.css"), 200);
    assert.equal(s.statuses.get("/assets/toolso-init.js"), 200);
    assert.equal(s.statuses.get("/assets/toolso.js"), 200);
    assert.equal(s.statuses.get("/assets/fonts/Geist-Variable.woff2"), 200);
    assert.equal(await s.page.evaluate(() => document.fonts.check('16px "Geist"')), true);
    assert.equal(await s.page.evaluate(() => document.documentElement.classList.contains("js")), true);
  } finally {
    await s.close();
  }
});

test("P12 catalog and detail pages load without console errors", async () => {
  for (const path of ["/zh/tools", "/zh/tools/category/design", "/zh/tools/figma", "/en/tools/figma"]) {
    const s = await open(path);
    try {
      assert.deepEqual(s.errors, [], path);
    } finally {
      await s.close();
    }
  }
});

test("P12 theme toggle switches html.dark, persists, and applies before paint on reload", async () => {
  const s = await open("/");
  try {
    const html = () =>
      s.page.evaluate(() => ({
        dark: document.documentElement.classList.contains("dark"),
        scheme: document.documentElement.style.colorScheme,
        stored: localStorage.getItem("theme"),
      }));
    assert.deepEqual(await html(), { dark: false, scheme: "light", stored: null });
    const toggle = s.page.locator("[data-theme-toggle]:visible").first();
    await toggle.click();
    assert.deepEqual(await html(), { dark: true, scheme: "dark", stored: "dark" });
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    await s.page.reload();
    assert.equal((await html()).dark, true);
    // Before paint: with toolso.js stubbed out, toolso-init.js alone must apply the stored theme.
    await s.page.route("**/assets/toolso.js", (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript", body: "" }),
    );
    await s.page.reload();
    assert.deepEqual(await html(), { dark: true, scheme: "dark", stored: "dark" });
    await s.page.unroute("**/assets/toolso.js");
    await s.page.reload();
    await s.page.locator("[data-theme-toggle]:visible").first().click();
    assert.deepEqual(await html(), { dark: false, scheme: "light", stored: "light" });
    await s.page.reload();
    assert.equal((await html()).dark, false);
  } finally {
    await s.close();
  }
});

test("P12 [data-toggle] panels open, close on Escape (focus returns) and on outside click", async () => {
  const s = await open("/");
  try {
    const button = s.page.locator("[data-toggle]:visible").first();
    const id = await button.getAttribute("data-toggle");
    assert.ok(id, "a visible [data-toggle] button");
    const panel = s.page.locator(`[id="${id}"]`);
    assert.equal(await panel.isVisible(), false);
    await button.click();
    assert.equal(await panel.isVisible(), true);
    assert.equal(await button.getAttribute("aria-expanded"), "true");
    await s.page.keyboard.press("Escape");
    assert.equal(await panel.isVisible(), false);
    assert.equal(await button.getAttribute("aria-expanded"), "false");
    assert.equal(await button.evaluate((el) => el === document.activeElement), true);
    await button.click();
    assert.equal(await panel.isVisible(), true);
    await s.page.mouse.click(5, 700);
    assert.equal(await panel.isVisible(), false);
    // Opening another toggle closes the first one.
    const toggles = s.page.locator("[data-toggle]:visible");
    if ((await toggles.count()) > 1) {
      await button.click();
      const other = toggles.nth(1);
      const otherId = await other.getAttribute("data-toggle");
      if (otherId !== id) {
        await other.click();
        assert.equal(await panel.isVisible(), false);
        assert.equal(await s.page.locator(`[id="${otherId}"]`).isVisible(), true);
      }
    }
  } finally {
    await s.close();
  }
});

test("P12 mobile: a toggle inside an open panel keeps the panel open; Escape unwinds one level", async () => {
  const s = await open("/");
  try {
    await s.page.setViewportSize({ width: 390, height: 844 });
    const opener = s.page.locator("[data-toggle]:visible").first();
    const panelId = await opener.getAttribute("data-toggle");
    const panel = s.page.locator(`[id="${panelId}"]`);
    await opener.click();
    assert.equal(await panel.isVisible(), true);
    const nested = panel.locator("[data-toggle]:visible");
    const inner = await nested.evaluateAll(
      (els, outer) => els.findIndex((el) => el.getAttribute("data-toggle") !== outer),
      panelId,
    );
    assert.ok(inner >= 0, "a nested [data-toggle] inside the open panel");
    const innerButton = nested.nth(inner);
    const innerPanel = s.page.locator(`[id="${await innerButton.getAttribute("data-toggle")}"]`);
    await innerButton.click();
    assert.equal(await innerPanel.isVisible(), true);
    assert.equal(await panel.isVisible(), true);
    await s.page.keyboard.press("Escape");
    assert.equal(await innerPanel.isVisible(), false);
    assert.equal(await panel.isVisible(), true);
    await s.page.keyboard.press("Escape");
    assert.equal(await panel.isVisible(), false);
    assert.equal(await opener.evaluate((el) => el === document.activeElement), true);
  } finally {
    await s.close();
  }
});

test("P12 mobile menu is a modal dialog: focus inside, Escape out, body scroll locked", async () => {
  const s = await open("/");
  try {
    await s.page.setViewportSize({ width: 390, height: 844 });
    const opener = s.page.locator('[data-toggle="mobile-nav"]:visible').first();
    const dialog = s.page.locator("#mobile-nav");
    assert.equal(await dialog.evaluate((el) => el.tagName), "DIALOG");
    const state = () =>
      dialog.evaluate((el) => ({
        open: (el as HTMLDialogElement).open,
        modal: el.matches(":modal"),
        locked: document.body.style.overflow === "hidden",
      }));
    await opener.click();
    assert.deepEqual(await state(), { open: true, modal: true, locked: true });
    assert.equal(
      await s.page.evaluate(() => !!document.activeElement?.closest("#mobile-nav")),
      true,
    );
    await s.page.keyboard.press("Escape");
    await s.page.waitForFunction(
      (el) =>
        !(document.querySelector("#mobile-nav") as HTMLDialogElement | null)?.open &&
        el === document.activeElement &&
        document.body.style.overflow === "",
      await opener.elementHandle(),
      { timeout: 2000 },
    );
    assert.deepEqual(await state(), { open: false, modal: false, locked: false });
  } finally {
    await s.close();
  }
});

test("P12 category drawer focuses inside, and Escape/close return focus to the opener", async () => {
  const s = await open("/zh/tools");
  try {
    await s.page.setViewportSize({ width: 1440, height: 900 });
    const opener = s.page.locator('[data-toggle^="category-drawer-"]:visible').first();
    const id = await opener.getAttribute("data-toggle");
    assert.ok(id);
    const panel = s.page.locator(`[id="${id}"]`);
    // The drawer wrapper is a zero-width fixed box (its card is absolutely positioned), so
    // check the `hidden` attribute rather than Playwright visibility.
    const shown = () => panel.evaluate((el) => !(el as HTMLElement).hidden);
    const focusInPanel = () =>
      s.page.evaluate((pid) => !!document.getElementById(pid)?.contains(document.activeElement), id);

    await opener.click();
    assert.equal(await shown(), true);
    assert.equal(await focusInPanel(), true);
    await s.page.keyboard.press("Escape");
    assert.equal(await shown(), false);
    assert.equal(await opener.evaluate((el) => el === document.activeElement), true);

    await opener.click();
    await panel.locator(`[data-toggle="${id}"]`).click();
    assert.equal(await shown(), false);
    assert.equal(await opener.evaluate((el) => el === document.activeElement), true);
  } finally {
    await s.close();
  }
});

test("P12 role=menu panels follow the menu-button keyboard pattern", async () => {
  const s = await open("/");
  try {
    await s.page.setViewportSize({ width: 1440, height: 900 });
    const button = s.page.locator('[data-toggle="language-menu"]:visible').first();
    const menu = s.page.locator("#language-menu");
    const activeIndex = () =>
      s.page.evaluate(() => {
        const items = [
          ...(document.querySelector("#language-menu")?.querySelectorAll('[role="menuitem"]') ?? []),
        ].filter((el) => !el.closest("[hidden]"));
        return items.indexOf(document.activeElement as Element);
      });

    await button.click();
    assert.equal(await menu.isVisible(), true);
    assert.equal(await activeIndex(), 0);
    await s.page.keyboard.press("Escape");
    assert.equal(await menu.isVisible(), false);
    assert.equal(await button.evaluate((el) => el === document.activeElement), true);

    await button.focus();
    await s.page.keyboard.press("ArrowDown");
    assert.equal(await menu.isVisible(), true);
    assert.equal(await activeIndex(), 0);
    await s.page.keyboard.press("ArrowDown");
    assert.equal(await activeIndex(), 1);
    await s.page.keyboard.press("ArrowUp");
    assert.equal(await activeIndex(), 0);
    await s.page.keyboard.press("ArrowUp");
    assert.equal(await activeIndex(), 1);
    await s.page.keyboard.press("Home");
    assert.equal(await activeIndex(), 0);
    await s.page.keyboard.press("End");
    assert.equal(await activeIndex(), 1);
    await s.page.keyboard.press("Tab");
    assert.equal(await menu.isVisible(), false);

    await button.focus();
    await s.page.keyboard.press("Space");
    assert.equal(await menu.isVisible(), true);
    assert.equal(await activeIndex(), 0);
    await s.page.keyboard.press("Escape");
    assert.equal(await menu.isVisible(), false);
    assert.equal(await button.evaluate((el) => el === document.activeElement), true);

    await s.page.keyboard.press("Enter");
    assert.equal(await menu.isVisible(), true);
    assert.equal(await activeIndex(), 0);
  } finally {
    await s.close();
  }
});

test("P12 navbar scroll state, card spotlight and reveal-on-scroll", async () => {
  const s = await open("/");
  try {
    const navbar = s.page.locator("[data-navbar]").first();
    assert.equal(await navbar.getAttribute("data-scrolled"), null);
    const reveals = s.page.locator(".site-reveal");
    assert.ok((await reveals.count()) > 0, "home has .site-reveal elements");
    // Walk down the page so every reveal enters the viewport.
    for (let y = 0; ; y += 400) {
      await s.page.evaluate((top) => scrollTo(0, top), y);
      await s.page.waitForTimeout(60);
      if (await s.page.evaluate((top) => top + innerHeight >= document.documentElement.scrollHeight, y)) break;
    }
    await s.page.waitForTimeout(100);
    assert.notEqual(await navbar.getAttribute("data-scrolled"), null);
    const hidden = await reveals.evaluateAll((els) =>
      els.filter((el) => !el.classList.contains("site-reveal-visible")).map((el) => el.outerHTML.slice(0, 80)),
    );
    assert.deepEqual(hidden, []);
    await s.page.evaluate(() => scrollTo(0, 0));
    await s.page.waitForTimeout(100);
    assert.equal(await navbar.getAttribute("data-scrolled"), null);

    const card = s.page.locator("[data-spotlight] .surface-card:visible").first();
    await card.scrollIntoViewIfNeeded();
    const box = (await card.boundingBox())!;
    await s.page.mouse.move(box.x + 10, box.y + 12);
    await s.page.mouse.move(box.x + 20, box.y + 15);
    const [mx, my] = await card.evaluate((el) => [
      (el as HTMLElement).style.getPropertyValue("--mx"),
      (el as HTMLElement).style.getPropertyValue("--my"),
    ]);
    assert.match(mx!, /^\d+(\.\d+)?px$/);
    assert.match(my!, /^\d+(\.\d+)?px$/);
  } finally {
    await s.close();
  }
});

test("P12 session menu shows the signed-out state", async () => {
  const s = await open("/");
  try {
    const sessions = s.page.locator("[data-session]");
    assert.ok((await sessions.count()) > 0, "a [data-session] container");
    await s.page.waitForFunction(() =>
      [...document.querySelectorAll("[data-session]")].every((el) => el.getAttribute("data-state") === "signed-out"),
    );
    assert.equal(await s.page.locator('[data-session] [data-when="signed-in"]:visible').count(), 0);
  } finally {
    await s.close();
  }
});

/** Detail page with the share sheet removed, so share/copy take the clipboard path deterministically. */
async function openDetail() {
  const s = await open("/zh/tools/figma", { clipboard: true });
  await s.page.addInitScript(() => {
    delete (Navigator.prototype as { share?: unknown }).share;
  });
  await s.page.reload();
  await s.page.waitForTimeout(300);
  return s;
}
const clearMessage = (page: Page) =>
  page.evaluate(() => {
    document.querySelector("#message")!.textContent = "";
  });
const noticeText = async (page: Page) => {
  await page.waitForFunction(() => document.querySelector("#message")?.textContent);
  return message(page).textContent();
};

test("P12 detail: signed-out favorite shows the 401 notice in the toolso status line", async () => {
  const s = await openDetail();
  try {
    await s.page.locator(".favorite:visible").first().click();
    assert.equal(await noticeText(s.page), "请先登录，再使用收藏与投稿。");
    // directory.js must not wipe the toolso status line's own classes.
    assert.match((await message(s.page).getAttribute("class")) ?? "", /\bfixed\b/);
    assert.equal(await message(s.page).isVisible(), true);
  } finally {
    await s.close();
  }
});

test("P12 detail: the share menu copies the page link and offers X/Telegram links", async () => {
  const s = await openDetail();
  try {
    const trigger = s.page.locator('[data-toggle="share-menu"]:visible').first();
    await trigger.click();
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    const menu = s.page.locator("#share-menu");
    assert.equal(await menu.isVisible(), true);
    assert.equal(await menu.locator('a[href^="https://twitter.com/intent/tweet"]').count(), 1);
    assert.equal(await menu.locator('a[href^="https://t.me/share/url"]').count(), 1);
    await clearMessage(s.page);
    await menu.locator("[data-copy]").click();
    assert.match((await noticeText(s.page)) ?? "", /链接已复制|Link copied/);
    assert.equal(await s.page.evaluate(() => navigator.clipboard.readText()), `${ORIGIN}/zh/tools/figma`);
    // Notices clear themselves.
    await s.page.waitForFunction(() => !document.querySelector("#message")?.textContent, null, { timeout: 6000 });
    await s.page.keyboard.press("Escape");
    assert.equal(await menu.isVisible(), false);
  } finally {
    await s.close();
  }
});

test("P12 detail: reading progress and the current section in [data-section-nav]", async () => {
  const s = await openDetail();
  try {
    const bar = s.page.locator("[data-reading-progress]");
    const progress = async () =>
      Number(await bar.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--progress")));
    await s.page.evaluate(() => scrollTo(0, 0));
    await s.page.waitForTimeout(100);
    const start = await progress();
    await s.page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await s.page.waitForTimeout(150);
    const end = await progress();
    assert.ok(start >= 0 && start < 0.5, `progress at top ${start}`);
    assert.ok(end > start && end <= 1, `progress at bottom ${end}`);

    await s.page.evaluate(() => scrollTo(0, 0));
    const links = s.page.locator("[data-section-nav] a[href^='#']:visible");
    assert.ok((await links.count()) > 0, "section links");
    const link = links.last();
    await link.click();
    // html { scroll-behavior: smooth }: wait for the scroll to settle rather than a fixed delay.
    await s.page.waitForFunction(
      (el) => el?.getAttribute("aria-current") === "true",
      await link.elementHandle(),
      { timeout: 5000 },
    );
    assert.equal(await s.page.locator("[data-section-nav] a[aria-current='true']:visible").count(), 1);
    assert.equal(new URL(s.page.url()).hash, await link.getAttribute("href"));
  } finally {
    await s.close();
  }
});

test("P12 detail: cover lightbox opens modally and closes on Escape, close button and backdrop", async () => {
  // Give Figma a cover. The media file itself does not exist (its request 404s); only the
  // dialog behaviour is under test here.
  await f.pool.query(
    `UPDATE publication SET image='{"mediaId":"00000000-0000-4000-8000-0000000000aa","alt":"Figma","version":1}'::jsonb WHERE site_id='atlas' AND slug='figma' AND locale='zh'`,
  );
  const s = await open("/zh/tools/figma");
  try {
    const trigger = s.page.locator("[data-lightbox-open]:visible").first();
    const id = await trigger.getAttribute("data-lightbox-open", { timeout: 2000 });
    const dialog = s.page.locator(`[id="${id}"]`);
    const state = () =>
      dialog.evaluate((el) => ({
        open: (el as HTMLDialogElement).open,
        modal: el.matches(":modal"),
        locked: document.body.style.overflow === "hidden",
      }));
    await trigger.click();
    assert.deepEqual(await state(), { open: true, modal: true, locked: true });
    assert.equal(
      await s.page.evaluate(() => document.activeElement?.matches("[data-lightbox-close]:not([aria-hidden='true'])")),
      true,
    );
    await s.page.keyboard.press("Escape");
    // The dialog "close" event (scroll unlock, focus return) is dispatched asynchronously.
    await s.page.waitForFunction(
      (el) => document.body.style.overflow === "" && el === document.activeElement,
      await trigger.elementHandle(),
      { timeout: 2000 },
    );
    assert.deepEqual(await state(), { open: false, modal: false, locked: false });

    await trigger.click();
    await dialog.locator("[data-lightbox-close]:not([aria-hidden='true'])").click();
    assert.equal((await state()).open, false);

    await trigger.click();
    await s.page.mouse.click(8, 8); // outside the image: the backdrop
    assert.equal((await state()).open, false);
  } finally {
    await s.close();
    await f.pool.query(`UPDATE publication SET image=NULL WHERE site_id='atlas' AND slug='figma' AND locale='zh'`);
  }
});
