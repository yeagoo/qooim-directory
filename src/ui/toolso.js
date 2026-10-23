// Interactivity for the toolso template. Pages are rendered once on the server to static
// markup (no hydration, no client React), so the client behaviour of toolso's React
// components is re-implemented here as small vanilla handlers bound to data attributes.
// Loaded as a module (deferred, module scope: nothing leaks to window). Every handler is
// optional: missing elements are skipped, and failures of one never stop the others.
// CSP: no inline styles in markup, so the few per-element values (reveal timing, spotlight
// position, progress) are written through the CSSOM (style.setProperty), which CSP allows.
// User-visible strings come from data attributes (see src/templates/toolso/i18n/qooim-client.ts),
// with Chinese fallbacks.

const doc = document;
const root = doc.documentElement;
const all = (selector, scope = doc) => [...scope.querySelectorAll(selector)];
const attr = (el, name, fallback) => el?.getAttribute(name) || fallback;
const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// Modal overlays (mobile nav, lightbox) share the body scroll lock, so closing one never
// unlocks the page while another is still open.
const scrollLocks = new Set();
function setScrollLock(key, locked) {
  if (locked) scrollLocks.add(key);
  else scrollLocks.delete(key);
  if (scrollLocks.size) doc.body.style.setProperty("overflow", "hidden");
  else doc.body.style.removeProperty("overflow");
}

// ── #message notices (the status line /assets/directory.js also writes to) ──────────────
let noticeTimer = 0;
function notice(text) {
  const message = doc.getElementById("message");
  if (!message) return;
  message.textContent = text;
  clearTimeout(noticeTimer);
  if (text)
    noticeTimer = setTimeout(() => {
      // Leave a newer notice (for example from directory.js) alone.
      if (message.textContent === text) message.textContent = "";
    }, 4000);
}

// ── Clipboard ────────────────────────────────────────────────────────────────────────────
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No async clipboard (plain-http preview, denied permission): legacy selection copy.
    try {
      const area = doc.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.setProperty("position", "fixed");
      area.style.setProperty("opacity", "0");
      area.style.setProperty("pointer-events", "none");
      doc.body.append(area);
      area.select();
      const ok = doc.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// ── Theme toggle ─────────────────────────────────────────────────────────────────────────
// Ported from toolso-ai-open src/components/mode-toggle.tsx and the next-themes setup in
// src/app/[locale]/layout.tsx (attribute="class", defaultTheme="light", enableSystem,
// disableTransitionOnChange) (Apache-2.0, Copyright 2025 CoolChange.AI).
// Changes: plain DOM; the transition freeze is a Tailwind class instead of an injected <style>
// (CSP forbids inline styles). toolso-init.js applies the stored theme before first paint.
function setupTheme() {
  const buttons = all("[data-theme-toggle]");
  const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  const stored = () => {
    try {
      return localStorage.getItem("theme");
    } catch {
      return null;
    }
  };
  const resolve = (theme) => (theme === "system" ? (media?.matches ? "dark" : "light") : theme === "dark" ? "dark" : "light");
  const sync = () => {
    const dark = root.classList.contains("dark");
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(dark));
      button.dataset.theme = dark ? "dark" : "light";
    }
  };
  const apply = (theme) => {
    const resolved = resolve(theme);
    // next-themes disableTransitionOnChange: freeze transitions for one frame while colours swap.
    const freeze = "[&_*]:!transition-none";
    root.classList.add(freeze);
    root.classList.toggle("dark", resolved === "dark");
    root.style.colorScheme = resolved;
    void getComputedStyle(doc.body).opacity;
    setTimeout(() => root.classList.remove(freeze), 1);
    sync();
  };
  for (const button of buttons)
    button.addEventListener("click", () => {
      const next = root.classList.contains("dark") ? "light" : "dark";
      try {
        localStorage.setItem("theme", next);
      } catch {}
      apply(next);
    });
  // next-themes keeps tabs in sync and follows the OS while the choice is "system".
  addEventListener("storage", (event) => {
    if (event.key === "theme") apply(event.newValue || "light");
  });
  media?.addEventListener?.("change", () => {
    if (stored() === "system") apply("system");
  });
  sync();
}

// ── Disclosure toggles: mobile nav, categories, language, user menu, mobile filters ──────
// Ported from toolso-ai-open src/features/navigation/components/{categories-menu,mobile-navbar,
// user-menu}.tsx and src/components/language-switcher.tsx (Apache-2.0, Copyright 2025 CoolChange.AI).
// Changes: one generic handler: `[data-toggle=id]` + aria-controls/aria-expanded toggles the
// `hidden` attribute of #id (a <dialog> target opens modally, like toolso's mobile menu, and
// locks body scroll). Role="menu" panels get the WAI-ARIA menu-button keyboard pattern:
// focus the first item on open, ArrowUp/ArrowDown/Home/End move (wrapping), and Tab closes.
// Menuitems use tabindex="-1" (roving), and items inside a hidden sub-section are skipped.
// Closes on Escape (focus back to the button), outside click, a link click inside the panel,
// and when another toggle opens (unless the new toggle sits inside the open panel). Closing via
// a [data-toggle] button inside the panel also returns focus to the opener.
function setupToggles() {
  const buttons = all("[data-toggle]");
  if (!buttons.length) return;
  const open = []; // stack of { panel, button }
  const panelOf = (button) => doc.getElementById(button.dataset.toggle || "");
  const isOpen = (panel) => (panel instanceof HTMLDialogElement ? panel.open : !panel.hidden);
  const visible = (el) => !el.closest("[hidden]");
  const menuItems = (panel) => all('[role="menuitem"]', panel).filter(visible);
  const focusable = (panel) =>
    all(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      panel,
    ).filter(visible);
  const focusInside = (panel) => {
    if (panel.getAttribute("role") === "menu") {
      menuItems(panel)[0]?.focus({ preventScroll: true });
      return;
    }
    const dialog = panel instanceof HTMLDialogElement ? panel : panel.querySelector('[role="dialog"]');
    if (dialog) focusable(dialog)[0]?.focus({ preventScroll: true });
  };
  const syncButtons = (panel) => {
    for (const button of buttons)
      if (button.dataset.toggle === panel.id) button.setAttribute("aria-expanded", String(isOpen(panel)));
  };
  const close = (panel, focusButton) => {
    const index = open.findIndex((entry) => entry.panel === panel);
    const entry = index >= 0 ? open.splice(index, 1)[0] : null;
    // Close anything opened from inside this panel too.
    for (const nested of open.filter((other) => panel.contains(other.button))) close(nested.panel, false);
    if (panel instanceof HTMLDialogElement) {
      if (panel.open) panel.close();
      setScrollLock(`toggle:${panel.id}`, false);
    }
    panel.hidden = true;
    syncButtons(panel);
    if (focusButton && entry?.button?.isConnected) entry.button.focus();
  };
  const show = (panel, button) => {
    for (const other of [...open])
      if (other.panel !== panel && !other.panel.contains(button)) close(other.panel, false);
    panel.hidden = false;
    if (panel instanceof HTMLDialogElement && !panel.open) {
      if (typeof panel.showModal === "function") panel.showModal();
      else panel.setAttribute("open", "");
      setScrollLock(`toggle:${panel.id}`, true);
    }
    open.push({ panel, button });
    syncButtons(panel);
    focusInside(panel);
  };
  for (const button of buttons) {
    const panel = panelOf(button);
    if (!panel) continue;
    if (!button.hasAttribute("aria-controls")) button.setAttribute("aria-controls", panel.id);
    button.setAttribute("aria-expanded", String(isOpen(panel)));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (isOpen(panel)) close(panel, panel.contains(button));
      else show(panel, button);
    });
    if (panel.getAttribute("role") === "menu") {
      button.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown" || isOpen(panel)) return;
        event.preventDefault();
        show(panel, button);
      });
    }
    if (panel instanceof HTMLDialogElement && !panel.dataset.toggleBound) {
      panel.dataset.toggleBound = "";
      // Native Escape on a modal dialog fires "cancel": route it through close() for focus/state.
      panel.addEventListener("cancel", (event) => {
        event.preventDefault();
        close(panel, true);
      });
    }
    if (panel.getAttribute("role") === "menu" && !panel.dataset.menuBound) {
      panel.dataset.menuBound = "";
      for (const item of all('[role="menuitem"]', panel)) item.setAttribute("tabindex", "-1");
      panel.addEventListener("keydown", (event) => {
        if (!isOpen(panel)) return;
        const items = menuItems(panel);
        if (!items.length) return;
        const index = items.indexOf(doc.activeElement);
        const move = (next) => {
          event.preventDefault();
          items[(next + items.length) % items.length]?.focus({ preventScroll: true });
        };
        if (event.key === "ArrowDown") move(index < 0 ? 0 : index + 1);
        else if (event.key === "ArrowUp") move(index < 0 ? items.length - 1 : index - 1);
        else if (event.key === "Home") move(0);
        else if (event.key === "End") move(items.length - 1);
        else if (event.key === "Tab") close(panel, true);
      });
    }
  }
  doc.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !open.length) return;
    const top = open[open.length - 1];
    if (top.panel instanceof HTMLDialogElement) return; // handled by "cancel"
    event.preventDefault();
    close(top.panel, true);
  });
  doc.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    for (const entry of [...open].reverse()) {
      if (entry.panel.contains(target) || entry.button.contains(target)) break;
      if (all(`[data-toggle="${CSS.escape(entry.panel.id)}"]`).some((b) => b.contains(target))) break;
      // A click on the backdrop of a modal dialog targets the dialog itself.
      close(entry.panel, false);
    }
  });
  doc.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link) return;
    for (const entry of [...open].reverse()) if (entry.panel.contains(link)) close(entry.panel, false);
  });
  for (const entry of open) syncButtons(entry.panel);
}

// ── Navbar scroll state ──────────────────────────────────────────────────────────────────
// Ported from toolso-ai-open src/features/navigation/components/use-scrolled-past.ts and navbar.tsx
// (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: toggles a `data-scrolled` attribute
// (rAF-throttled) instead of a React prop. toolso's threshold is 100px; `data-navbar="<px>"` overrides it.
function setupNavbar() {
  const navbars = all("[data-navbar]");
  if (!navbars.length) return;
  let frame = 0;
  const update = () => {
    frame = 0;
    for (const navbar of navbars) {
      const threshold = Number.parseFloat(navbar.dataset.navbar || "");
      const scrolled = scrollY > (Number.isFinite(threshold) ? threshold : 100);
      if (scrolled !== navbar.hasAttribute("data-scrolled")) navbar.toggleAttribute("data-scrolled", scrolled);
    }
  };
  addEventListener(
    "scroll",
    () => {
      if (!frame) frame = requestAnimationFrame(update);
    },
    { passive: true },
  );
  update();
}

// ── Card spotlight ───────────────────────────────────────────────────────────────────────
// Ported from toolso-ai-open src/components/spotlight.tsx (Apache-2.0, Copyright 2025 CoolChange.AI).
// Changes: a delegated listener on each [data-spotlight] container instead of a React prop.
function setupSpotlight() {
  for (const container of all("[data-spotlight]"))
    container.addEventListener("pointermove", (event) => {
      if (event.pointerType !== "mouse") return;
      const card = event.target instanceof Element ? event.target.closest(".surface-card") : null;
      if (!card || !container.contains(card)) return;
      const rect = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${event.clientX - rect.left}px`);
      card.style.setProperty("--my", `${event.clientY - rect.top}px`);
    });
}

// ── Reveal on scroll ─────────────────────────────────────────────────────────────────────
// Ported from toolso-ai-open src/components/reveal.tsx and src/lib/motion.ts (Apache-2.0,
// Copyright 2025 CoolChange.AI). Changes: the per-element CSS variables that <Reveal> put in a
// style attribute are written through the CSSOM from html[data-motion] and the optional
// data-reveal-index (stagger, default 0) / data-reveal-y (px, default 24) attributes.
// data-reveal="mount" plays immediately; everything else waits for the viewport.
const MOTION_PRESETS = {
  smooth: { distance: 1, duration: 0.9, ease: "easeOut", stagger: 0.09 },
  crisp: { distance: 0.55, duration: 0.26, ease: [0.4, 0, 0.2, 1], stagger: 0.07 },
  playful: { distance: 1.3, duration: 0.75, ease: "easeOut", stagger: 0.11, spring: true },
  minimal: { distance: 0, duration: 0.2, ease: "linear", stagger: 0.04 },
};
function cssEase(preset) {
  if (preset.spring) return "cubic-bezier(0.34, 1.4, 0.64, 1)";
  if (Array.isArray(preset.ease)) return `cubic-bezier(${preset.ease.join(", ")})`;
  if (preset.ease === "linear") return "linear";
  return "cubic-bezier(0.16, 1, 0.3, 1)";
}
function setupReveal() {
  const elements = all(".site-reveal");
  if (!elements.length) return;
  const preset = MOTION_PRESETS[root.dataset.motion] ?? MOTION_PRESETS.smooth;
  const number = (value, fallback) => {
    const parsed = Number.parseFloat(value ?? "");
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  for (const el of elements) {
    // Markup may already set these through classes (the <Reveal> port does); fill in only what
    // is missing, and let explicit data attributes win.
    const computed = getComputedStyle(el);
    const set = (name, value, explicit) => {
      if (explicit || !computed.getPropertyValue(name).trim()) el.style.setProperty(name, value);
    };
    set("--reveal-y", `${number(el.dataset.revealY, 24) * preset.distance}px`, "revealY" in el.dataset);
    set("--reveal-duration", `${preset.duration}s`, false);
    set("--reveal-delay", `${number(el.dataset.revealIndex, 0) * preset.stagger}s`, "revealIndex" in el.dataset);
    set("--reveal-ease", cssEase(preset), false);
  }
  const show = (el) => el.classList.add("site-reveal-visible");
  const pending = elements.filter((el) => !el.classList.contains("site-reveal-visible"));
  if (reducedMotion() || typeof IntersectionObserver === "undefined") {
    requestAnimationFrame(() => pending.forEach(show));
    return;
  }
  const mount = pending.filter((el) => el.dataset.reveal === "mount");
  requestAnimationFrame(() => mount.forEach(show));
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        show(entry.target);
        observer.unobserve(entry.target);
      }
    },
    // Low threshold + bottom inset: tall sections (long mobile grids) never reach 30% visibility.
    { threshold: 0.08, rootMargin: "0px 0px -8% 0px" },
  );
  for (const el of pending) if (el.dataset.reveal !== "mount") observer.observe(el);
}

// ── Reading progress + section navigation (detail pages) ────────────────────────────────
// Ported from toolso-ai-open src/features/tools/components/tool-detail-shell.tsx and
// detail-section-nav.tsx (Apache-2.0, Copyright 2025 CoolChange.AI).
// Changes: one rAF-throttled measurement drives `--progress` (0..1) on [data-reading-progress]
// (relative to [data-reading-target] when present, else the whole page, as toolso did) and
// aria-current="true" on the [data-section-nav] link of the section being read.
const ACTIVE_TOLERANCE_PX = 8;
function setupDetail() {
  const bars = all("[data-reading-progress]");
  const navs = all("[data-section-nav]");
  if (!bars.length && !navs.length) return;
  const links = navs.flatMap((nav) => all('a[href^="#"]', nav));
  const ids = [...new Set(links.map((link) => decodeURIComponent(link.getAttribute("href").slice(1))).filter(Boolean))];
  let requested = null; // last section reached through a nav link, until the user scrolls
  let frame = 0;

  const measure = () => {
    frame = 0;
    const scrolled = scrollY;
    const max = doc.documentElement.scrollHeight - innerHeight;
    if (bars.length) {
      const target = doc.querySelector("[data-reading-target]");
      let progress;
      if (target) {
        const rect = target.getBoundingClientRect();
        const span = rect.height - innerHeight;
        progress = span > 0 ? -rect.top / span : rect.top <= 0 ? 1 : 0;
      } else progress = max > 0 ? scrolled / max : 0;
      progress = Math.min(1, Math.max(0, progress));
      for (const bar of bars) bar.style.setProperty("--progress", progress.toFixed(4));
    }
    if (!ids.length) return;
    const anchorLine = Number.parseFloat(getComputedStyle(root).scrollPaddingTop) || 0;
    let current = null;
    let currentTop = -Infinity;
    const below = [];
    for (const id of ids) {
      const el = doc.getElementById(id);
      if (!el) continue;
      const top = el.getBoundingClientRect().top;
      const landing = anchorLine + (Number.parseFloat(getComputedStyle(el).scrollMarginTop) || 0);
      if (top <= landing + ACTIVE_TOLERANCE_PX) {
        if (top > currentTop) {
          current = id;
          currentTop = top;
        }
      } else if (top < innerHeight) below.push({ id, top });
    }
    // Scrolled to the bottom: short trailing sections never reach the anchor line.
    if (max > 0 && scrolled >= max - 1 && below.length) {
      below.sort((a, b) => a.top - b.top);
      current = (below.find((s) => s.id === requested) ?? below[below.length - 1]).id;
    }
    for (const link of links) {
      const active = current !== null && decodeURIComponent(link.getAttribute("href").slice(1)) === current;
      if (active) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
    // Keep the active tab visible in horizontally scrolling strips (only the strip scrolls).
    for (const nav of navs) {
      const link = nav.querySelector('a[aria-current="true"]');
      if (!link) continue;
      let strip = link.parentElement;
      while (strip && strip !== nav.parentElement && strip.scrollWidth <= strip.clientWidth) strip = strip.parentElement;
      if (!strip || strip === nav.parentElement || strip.clientWidth === 0) continue;
      const left = link.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
      const right = left + link.offsetWidth;
      if (left < strip.scrollLeft) strip.scrollTo({ left: Math.max(0, left - 16) });
      else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollTo({ left: right - strip.clientWidth + 16 });
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };
  const forget = () => {
    if (requested === null) return;
    requested = null;
    schedule();
  };
  // Section links: replace (not push) the hash and move focus, like toolso's goToSection.
  for (const link of links)
    link.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      const id = decodeURIComponent(link.getAttribute("href").slice(1));
      const el = doc.getElementById(id);
      if (!el) return;
      event.preventDefault();
      requested = id;
      try {
        history.replaceState(history.state, "", `#${el.id}`);
      } catch {}
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      el.focus({ preventScroll: true });
      el.scrollIntoView();
      schedule();
    });
  measure();
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", schedule);
  addEventListener("wheel", forget, { passive: true });
  addEventListener("touchmove", forget, { passive: true });
  addEventListener("keydown", forget);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(schedule).observe(doc.body);
}

// ── Share + copy ─────────────────────────────────────────────────────────────────────────
// Ported from toolso-ai-open src/features/tools/components/share-button.tsx (Apache-2.0,
// Copyright 2025 CoolChange.AI). Changes: the native share sheet when available, otherwise a
// clipboard copy; feedback goes to #message instead of a sonner toast.
function setupShare() {
  for (const button of all("[data-share]"))
    button.addEventListener("click", async () => {
      const url = new URL(attr(button, "data-url", location.href), location.href).toString();
      const title = attr(button, "data-title", doc.title);
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ title, url });
          const shared = button.getAttribute("data-shared-label");
          if (shared) notice(shared);
          return;
        } catch (error) {
          if (error?.name === "AbortError") return; // the user closed the share sheet
        }
      }
      notice(
        (await copyText(url))
          ? attr(button, "data-copied-label", "链接已复制")
          : attr(button, "data-failed-label", "复制失败，请手动复制。"),
      );
    });
  for (const button of all("[data-copy]"))
    button.addEventListener("click", async () => {
      notice(
        (await copyText(button.getAttribute("data-copy") ?? ""))
          ? attr(button, "data-copied-label", "已复制")
          : attr(button, "data-failed-label", "复制失败，请手动复制。"),
      );
    });
}

// ── Cover lightbox ───────────────────────────────────────────────────────────────────────
// Ported from toolso-ai-open src/features/tools/components/cover-lightbox.tsx (Apache-2.0,
// Copyright 2025 CoolChange.AI). Changes: a native <dialog> opened with showModal() supplies the
// focus trap, Escape and focus return; backdrop clicks and [data-lightbox-close] close it. The
// body scroll lock is shared with modal [data-toggle] panels.
function setupLightbox() {
  for (const trigger of all("[data-lightbox-open]")) {
    const dialog = doc.getElementById(trigger.getAttribute("data-lightbox-open") || "");
    if (!(dialog instanceof HTMLDialogElement)) continue;
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      if (dialog.open) return;
      dialog.hidden = false;
      dialog.showModal();
      setScrollLock(`lightbox:${dialog.id}`, true);
      // toolso moved focus to the close button (skip an aria-hidden backdrop close target).
      dialog.querySelector('[data-lightbox-close]:not([aria-hidden="true"]):not([tabindex="-1"])')?.focus();
    });
    if (dialog.dataset.lightboxBound !== undefined) continue;
    dialog.dataset.lightboxBound = "";
    dialog.addEventListener("close", () => {
      if (dialog.open) return; // reopened before the queued close event ran
      setScrollLock(`lightbox:${dialog.id}`, false);
      if (trigger.isConnected) trigger.focus();
    });
    dialog.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target === dialog || target?.closest("[data-lightbox-close]")) dialog.close();
    });
  }
}

// ── Session menu ─────────────────────────────────────────────────────────────────────────
// Re-implemented (toolso used better-auth's React session hook in user-menu.tsx): reads
// /api/session and signs out the way /assets/directory.js does (same request and messages).
async function signOutRequest() {
  const response = await fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // A proxy error page or truncated body must not hide the HTTP status.
  }
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "请先登录，再使用收藏与投稿。"
        : [data?.error, data?.message].find((value) => typeof value === "string" && value.trim()) ||
          `操作失败（HTTP ${response.status}），请稍后重试。`,
    );
  if (data === null || typeof data !== "object") throw new Error("");
  return data;
}
function setupSession() {
  const containers = all("[data-session]");
  if (!containers.length) return;
  const render = (user) => {
    for (const container of containers) {
      const signedIn = !!user?.email;
      container.dataset.state = signedIn ? "signed-in" : "signed-out";
      for (const el of all('[data-when="signed-in"]', container)) el.hidden = !signedIn;
      for (const el of all('[data-when="signed-out"]', container)) el.hidden = signedIn;
      for (const el of all("[data-email]", container)) el.textContent = signedIn ? user.email : "";
    }
  };
  void (async () => {
    try {
      const response = await fetch("/api/session", { headers: { accept: "application/json" } });
      render(response.ok ? await response.json() : null);
    } catch {
      render(null); // offline or previewed without a server
    }
  })();
  let signingOut = false;
  for (const button of all("[data-sign-out]"))
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      if (signingOut) return;
      signingOut = true;
      button.disabled = true;
      notice("");
      try {
        await signOutRequest();
        location.assign("/");
      } catch (error) {
        signingOut = false;
        button.disabled = false;
        notice(error?.message || attr(button, "data-failed-label", "未能确认退出结果，请刷新页面核对登录状态。"));
      }
    });
}

for (const setup of [setupTheme, setupToggles, setupNavbar, setupSpotlight, setupReveal, setupDetail, setupShare, setupLightbox, setupSession]) {
  try {
    setup();
  } catch (error) {
    console.warn("toolso:", setup.name, error);
  }
}
