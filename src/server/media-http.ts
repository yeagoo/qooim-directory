import { z } from "zod";
import type { Media } from "./media.js";
import type { Content } from "./content.js";
import { HttpError, type Operator } from "./operators.js";

const idPattern = /^\/media\/([0-9a-f-]{36})(?:\/(file))?$/;
const siteParam = (request: Request) =>
  z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,47}$/)
    .parse(new URL(request.url).searchParams.get("site"));
export async function mediaHttp(
  media: Media,
  content: Content,
  actor: Operator,
  action: string,
  request: Request,
  readBody: () => Promise<unknown>,
) {
  if (action === "/media" && request.method === "GET")
    return Response.json(await media.list(actor, siteParam(request)));
  // "usage" can never match idPattern, which requires a 36-character id.
  if (action === "/media/usage") {
    if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
    return Response.json(await media.usage(actor, siteParam(request)));
  }
  if (action === "/media" && request.method === "POST")
    return Response.json(await media.upload(actor, await readBody()), {
      status: 201,
    });
  const match = action.match(idPattern);
  if (!match) return null;
  const id = match[1]!,
    operation = match[2];
  if (operation === "file" && request.method === "GET") {
    const { row, data } = await media.adminFile(actor, id);
    return new Response(data, {
      headers: {
        "content-type": row.mime,
        "content-length": String(data.length),
        "cache-control": "private, no-store",
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (!operation && request.method === "DELETE") {
    const item = await media.get(actor, id);
    const usage = await content.mediaUsage(item.siteId, id);
    if (usage.published || usage.draft)
      throw new HttpError(409, "图片仍被已发布内容或草稿引用");
    await media.remove(actor, id);
    return Response.json({ ok: true });
  }
  return null;
}
