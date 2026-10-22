import { createHash } from "node:crypto";
import { z } from "zod";
import { repositoryName, sourceFields } from "../domain/project.js";
import { resourceData } from "./content.js";
import { HttpError } from "./operators.js";
import { fetchPublicText, publicUrl } from "./outbound.js";
import type { GithubClient } from "./github-client.js";

// Collector adapters. Every source kind is a row of collector_source and runs
// through the same tasks, worker, quotas, rate limits and retention. Two
// review models remain:
// - discovery (rss/npm/json): many items per run, deduplicated by external id
//   into collector_candidate and accepted as drafts;
// - binding (github): one source bound to one existing resource; statistics
//   update automatically, content changes go through field-level review in
//   github_candidate.

const locale = z.enum(["zh", "en"]);
export const rssConfig = z.strictObject({
  url: z.string().trim().max(500),
  locale: locale.default("zh"),
});
export const npmConfig = z.strictObject({
  query: z.string().trim().min(1).max(100),
  locale: locale.default("zh"),
});
export const jsonConfig = z.strictObject({
  url: z.string().trim().max(500),
  itemsPath: z.string().trim().max(120).default(""),
  idField: z.string().trim().min(1).max(80).default("id"),
  titleField: z.string().trim().min(1).max(80).default("title"),
  descriptionField: z.string().trim().min(1).max(80).default("description"),
  urlField: z.string().trim().min(1).max(80).default("url"),
  locale: locale.default("zh"),
});
export const githubConfig = z.strictObject({ repository: repositoryName });

const decode = (value: string) =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, number) =>
      String.fromCodePoint(parseInt(number, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const plain = (value: string) =>
  decode(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const tag = (block: string, name: string) =>
  new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block)?.[1] ??
  "";
const attr = (block: string, name: string, key = "href") =>
  new RegExp(`<${name}[^>]*\\s${key}=["']([^"']+)["'][^>]*>`, "i").exec(block)?.[1] ??
  "";
export type CollectedItem = {
  externalId: string;
  locale: "zh" | "en";
  data: z.infer<typeof resourceData>;
};
export function parseRss(xml: string, baseUrl: string, target: "zh" | "en") {
  if (/<!doctype|<!entity/i.test(xml)) throw new Error("unsafe_feed");
  if (Buffer.byteLength(xml) > 2 * 1024 * 1024) throw new Error("feed_too_large");
  const blocks = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((match) => match[2])
    .slice(0, 50);
  if (!blocks.length) throw new Error("empty_feed");
  const items: CollectedItem[] = [];
  for (const block of blocks) {
    const title = plain(tag(block, "title")).slice(0, 200);
    const link =
      plain(tag(block, "link")) ||
      attr(block, "link", "href") ||
      plain(tag(block, "guid"));
    let url: string;
    try {
      url = new URL(link, baseUrl).toString();
      if (!["http:", "https:"].includes(new URL(url).protocol)) continue;
    } catch {
      continue;
    }
    if (!title) continue;
    const description = plain(
      tag(block, "description") ||
        tag(block, "summary") ||
        tag(block, "content") ||
        title,
    ).slice(0, 2000);
    const externalId = (
      plain(tag(block, "guid")) ||
      plain(tag(block, "id")) ||
      url
    ).slice(0, 500);
    const data = resourceData.parse({
      url,
      kind: "website",
      source: "rss:" + new URL(baseUrl).hostname,
      translations: { [target]: { title, description } },
    });
    items.push({ externalId, locale: target, data });
  }
  if (!items.length) throw new Error("empty_feed");
  return items;
}
export function parseNpm(json: unknown, target: "zh" | "en") {
  const value = z
    .object({
      objects: z.array(
        z.object({
          package: z.object({
            name: z.string().min(1).max(214),
            description: z.string().max(2000).optional(),
            links: z
              .object({
                npm: z.string().url().optional(),
                homepage: z.string().url().optional(),
                repository: z.string().optional(),
              })
              .partial()
              .optional(),
          }),
        }),
      ),
    })
    .parse(json);
  return value.objects.slice(0, 50).map(({ package: pkg }) => {
    const candidates = [pkg.links?.homepage, pkg.links?.repository, pkg.links?.npm]
      .filter((item): item is string => !!item)
      .filter((item) => /^https?:\/\//.test(item));
    const url =
      candidates[0] ||
      `https://www.npmjs.com/package/${encodeURIComponent(pkg.name)}`;
    const title = pkg.name.slice(0, 200),
      description = (pkg.description || "npm package").slice(0, 2000);
    return {
      externalId: pkg.name,
      locale: target,
      data: resourceData.parse({
        url,
        kind: "website",
        source: "npm",
        translations: { [target]: { title, description } },
      }),
    };
  });
}
export function parseJsonFeed(
  json: unknown,
  config: z.infer<typeof jsonConfig>,
) {
  const pick = (value: unknown, path: string) => {
    if (!path) return value;
    let current: unknown = value;
    for (const key of path.split(".")) {
      if (!current || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  };
  const rows = pick(json, config.itemsPath);
  if (!Array.isArray(rows)) throw new Error("items_not_array");
  return rows.slice(0, 50).flatMap((row, index) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    const title = String(pick(record, config.titleField) ?? "").trim().slice(0, 200);
    const url = String(pick(record, config.urlField) ?? "").trim();
    if (!title || !url) return [];
    try {
      if (!["http:", "https:"].includes(new URL(url).protocol)) return [];
    } catch {
      return [];
    }
    const description = String(
      pick(record, config.descriptionField) ?? title,
    )
      .trim()
      .slice(0, 2000);
    const externalId = String(
      pick(record, config.idField) ?? url ?? index,
    ).slice(0, 500);
    return [
      {
        externalId,
        locale: config.locale,
        data: resourceData.parse({
          url,
          kind: "website",
          source: "json:" + new URL(config.url).hostname,
          translations: {
            [config.locale]: { title, description: description || title },
          },
        }),
      },
    ];
  });
}

export type Fetch = typeof fetchPublicText;
export type AdapterContext = {
  fetcher: Fetch;
  // Resolved lazily so discovery-only workers never need a GitHub client.
  github: () => GithubClient;
};
export type DiscoveryFetch =
  | { notModified: true }
  | { notModified: false; etag: string | null; items: CollectedItem[] };
export type BindingFetch = Awaited<ReturnType<GithubClient["repository"]>>;
export type BindingData = Extract<BindingFetch, { unchanged: false }>["data"];
type StoredConfig = Record<string, unknown> | null | undefined;
type AdapterBase<Config> = {
  kind: string;
  requiredModules: readonly string[];
  // Save-time validation; throws 400 for unsafe or malformed input.
  validateConfig(input: unknown): Config;
  // Short human label for task lists; tolerant of any stored config.
  label(config: StoredConfig): string;
};
export type DiscoveryAdapter<Config = unknown> = AdapterBase<Config> & {
  mode: "discovery";
  fetch(
    config: unknown,
    etag: string | null,
    context: AdapterContext,
  ): Promise<DiscoveryFetch>;
  // Candidate fingerprint: a pending candidate is only updated when it changes.
  contentHash(item: CollectedItem): string;
};
export type BindingAdapter<Config = unknown> = AdapterBase<Config> & {
  mode: "binding";
  fetch(
    config: unknown,
    etag: string | null,
    context: AdapterContext,
  ): Promise<BindingFetch>;
  // Hash of the reviewable content only: statistics are excluded so a stats
  // change never creates a review candidate.
  contentHash(data: BindingData): string;
  statsFields: readonly ("stars" | "forks" | "openIssues" | "pushedAt")[];
  reviewFields: readonly z.infer<typeof sourceFields>[number][];
};
export type Adapter = DiscoveryAdapter | BindingAdapter;

const publicConfigUrl = (url: string) => {
  try {
    publicUrl(url);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "URL 不合法");
  }
};
const fingerprint = (item: CollectedItem) =>
  createHash("sha256").update(JSON.stringify(item.data)).digest("hex");

const rss: DiscoveryAdapter<z.infer<typeof rssConfig>> = {
  kind: "rss",
  mode: "discovery",
  requiredModules: ["directory"],
  validateConfig(input) {
    const config = rssConfig.parse(input);
    publicConfigUrl(config.url);
    return config;
  },
  label: (config) => String(config?.url ?? ""),
  async fetch(raw, etag, { fetcher }) {
    const config = rssConfig.parse(raw);
    const response = await fetcher(config.url, { etag });
    if (response.notModified) return { notModified: true };
    return {
      notModified: false,
      etag: response.etag,
      items: parseRss(response.text, config.url, config.locale),
    };
  },
  contentHash: fingerprint,
};
const npm: DiscoveryAdapter<z.infer<typeof npmConfig>> = {
  kind: "npm",
  mode: "discovery",
  requiredModules: ["directory"],
  validateConfig: (input) => npmConfig.parse(input),
  label: (config) => "npm: " + String(config?.query ?? ""),
  async fetch(raw, etag, { fetcher }) {
    const config = npmConfig.parse(raw);
    const response = await fetcher(
      "https://registry.npmjs.org/-/v1/search?" +
        new URLSearchParams({
          text: "keywords:" + config.query,
          size: "50",
        }).toString(),
      { etag },
    );
    if (response.notModified) return { notModified: true };
    return {
      notModified: false,
      etag: response.etag,
      items: parseNpm(JSON.parse(response.text), config.locale),
    };
  },
  contentHash: fingerprint,
};
const json: DiscoveryAdapter<z.infer<typeof jsonConfig>> = {
  kind: "json",
  mode: "discovery",
  requiredModules: ["directory"],
  validateConfig(input) {
    const config = jsonConfig.parse(input);
    publicConfigUrl(config.url);
    return config;
  },
  label: (config) => String(config?.url ?? ""),
  async fetch(raw, etag, { fetcher }) {
    const config = jsonConfig.parse(raw);
    const response = await fetcher(config.url, { etag });
    if (response.notModified) return { notModified: true };
    return {
      notModified: false,
      etag: response.etag,
      items: parseJsonFeed(JSON.parse(response.text), config),
    };
  },
  contentHash: fingerprint,
};
const statKeys = ["stars", "forks", "openIssues", "pushedAt"] as const;
const github: BindingAdapter<z.infer<typeof githubConfig>> = {
  kind: "github",
  mode: "binding",
  requiredModules: ["directory", "opensource"],
  // Repository names are stored lower-case; remote_id guards replacement.
  validateConfig: (input) => {
    const config = githubConfig.parse(input);
    return { repository: config.repository.toLowerCase() };
  },
  label: (config) => String(config?.repository ?? ""),
  fetch: (raw, etag, context) =>
    context.github().repository(githubConfig.parse(raw).repository, etag),
  contentHash(data) {
    // Same serialization as the former GitHub worker, so stored last_hash values stay valid.
    const copy = structuredClone(data) as { project: Record<string, unknown> };
    for (const key of statKeys) copy.project[key] = key === "pushedAt" ? null : 0;
    return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
  },
  statsFields: statKeys,
  reviewFields: sourceFields.element.options,
};

export const adapters = { rss, npm, json, github } as const;
export type Kind = keyof typeof adapters;
export const kinds = Object.keys(adapters) as Kind[];
export const discoveryKinds = kinds.filter(
  (kind) => adapters[kind].mode === "discovery",
);
export const isKind = (value: unknown): value is Kind =>
  typeof value === "string" && Object.hasOwn(adapters, value);
export function adapter(kind: string): Adapter {
  if (!isKind(kind)) throw new Error("unknown_kind");
  return adapters[kind] as Adapter;
}
export const sourceLabel = (kind: string, config: StoredConfig) =>
  isKind(kind) ? adapters[kind].label(config) : String(config?.url ?? "");
// kind → modules the site must enable, for SQL (`$n::jsonb->s.kind`).
export const requiredModulesJson = (selected: readonly Kind[]) =>
  JSON.stringify(
    Object.fromEntries(selected.map((kind) => [kind, adapters[kind].requiredModules])),
  );
