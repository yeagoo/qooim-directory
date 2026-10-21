import { z } from "zod";
import type { GithubSources } from "./github.js";
import type { Operator } from "./operators.js";
export async function githubHttp(
  sources: GithubSources,
  actor: Operator,
  path: string,
  request: Request,
  body: () => Promise<unknown>,
) {
  if (!path.startsWith("/github/")) return null;
  const get = request.method === "GET";
  if (path === "/github/sources")
    return Response.json(
      get
        ? await sources.list(
            actor,
            Number(new URL(request.url).searchParams.get("page") ?? 1),
          )
        : await sources.save(actor, await body()),
    );
  if (path === "/github/review" && !get)
    return Response.json(
      await sources.content.reviewGithub(actor, await body()),
    );
  const match = path.match(/^\/github\/sources\/([0-9a-f-]{36})(\/sync)?$/);
  if (!match) return null;
  if (get && !match[2])
    return Response.json(await sources.detail(actor, match[1]));
  if (!get && match[2]) {
    const v = z.strictObject({ operationId: z.uuid() }).parse(await body());
    return Response.json(await sources.enqueue(actor, match[1], v.operationId));
  }
  return null;
}
