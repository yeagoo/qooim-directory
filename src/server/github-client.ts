import { z } from "zod";
import { repositoryName, projectSchema } from "../domain/project.js";
export class GithubError extends Error {
  constructor(
    readonly code: string,
    readonly retrySeconds: number | null = null,
  ) {
    super(code);
  }
}
const remoteSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  full_name: repositoryName,
  private: z.literal(false),
  description: z.string().max(5000).nullable(),
  stargazers_count: z.number(),
  forks_count: z.number(),
  open_issues_count: z.number(),
  language: z.string().nullable(),
  license: z.object({ spdx_id: z.string().nullable() }).nullable(),
  topics: z.array(z.string()).default([]),
  archived: z.boolean(),
  disabled: z.boolean().optional(),
  pushed_at: z.string().nullable(),
});
export class GithubClient {
  constructor(
    private transport: typeof fetch = fetch,
    private token: string | undefined = process.env.GITHUB_SYNC_TOKEN,
  ) {
    if (token)
      z.string()
        .min(1)
        .max(500)
        .regex(/^[\x21-\x7e]+$/)
        .parse(token);
  }
  async repository(name: string, etag?: string | null) {
    repositoryName.parse(name);
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2026-03-10",
      "user-agent": "Navigation-Network",
    };
    if (this.token) headers.authorization = "Bearer " + this.token;
    if (etag)
      headers["if-none-match"] = z
        .string()
        .max(200)
        .regex(/^[\x20-\x7e]+$/)
        .parse(etag);
    let response: Response;
    try {
      response = await this.transport(
        "https://api.github.com/repos/" +
          name.split("/").map(encodeURIComponent).join("/"),
        { headers, redirect: "manual", signal: AbortSignal.timeout(10000) },
      );
    } catch {
      throw new GithubError("network_failure", 30);
    }
    if ([403, 429].includes(response.status)) {
      const retry = response.headers.get("retry-after"),
        reset = Number(response.headers.get("x-ratelimit-reset"));
      const seconds = retry
        ? Number.isFinite(Number(retry))
          ? Number(retry)
          : (Date.parse(retry) - Date.now()) / 1000
        : response.headers.get("x-ratelimit-remaining") === "0" && reset
          ? (reset * 1000 - Date.now()) / 1000
          : 60;
      await response.body?.cancel();
      throw new GithubError(
        "rate_limited",
        Math.max(
          60,
          Math.min(86400, Math.ceil(Number.isFinite(seconds) ? seconds : 60)),
        ),
      );
    }
    if (response.status === 304) {
      await response.body?.cancel();
      if (!etag) throw new GithubError("unexpected_not_modified");
      return { unchanged: true as const };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new GithubError(
        response.status >= 300 && response.status < 400
          ? "repository_redirect"
          : response.status === 404
            ? "not_found"
            : response.status === 401
              ? "authentication_failed"
              : "upstream_failure",
        response.status >= 500 ? 30 : null,
      );
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader)
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 262144) {
            await reader.cancel();
            throw new GithubError("response_too_large");
          }
          chunks.push(part.value);
        }
      const repo = remoteSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString()),
      );
      if (repo.disabled || repo.full_name.toLowerCase() !== name.toLowerCase())
        throw new GithubError("repository_mismatch");
      const project = projectSchema.parse({
        provider: "github",
        repoId: String(repo.id),
        fullName: repo.full_name,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        openIssues: repo.open_issues_count,
        language: repo.language,
        license:
          repo.license?.spdx_id === "NOASSERTION"
            ? null
            : (repo.license?.spdx_id ?? null),
        topics: repo.topics,
        archived: repo.archived,
        pushedAt: repo.pushed_at,
      });
      const result = {
        kind: "repository" as const,
        url: "https://github.com/" + repo.full_name,
        source: "https://api.github.com/repos/" + repo.full_name,
        project,
        translations: {
          en: {
            title: repo.full_name,
            description: repo.description?.trim() || repo.full_name,
          },
        },
      };
      const tag = response.headers.get("etag");
      return {
        unchanged: false as const,
        data: result,
        etag: tag && /^[\x20-\x7e]{1,200}$/.test(tag) ? tag : null,
      };
    } catch (error) {
      if (error instanceof GithubError) throw error;
      if (error instanceof SyntaxError || error instanceof z.ZodError)
        throw new GithubError("invalid_repository");
      throw new GithubError("network_failure", 30);
    }
  }
}
