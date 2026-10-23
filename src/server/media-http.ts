import { z } from "zod";
import type { Media } from "./media.js";
import type { Content } from "./content.js";
import { HttpError, type Operator } from "./operators.js";

// /media/<id>[/file|/replace|/versions[/<v>[/file|/restore]]]
const idPattern =
  /^\/media\/([0-9a-f-]{36})(?:\/(file|replace|versions)(?:\/([0-9]{1,9})(?:\/(file|restore))?)?)?$/;
const fileHeaders = (mime: string, length: number) => ({
  "content-type": mime,
  "content-length": String(length),
  "cache-control": "private, no-store",
  "content-disposition": "inline",
  "x-content-type-options": "nosniff",
});
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
    operation = match[2],
    version = match[3] === undefined ? undefined : Number(match[3]),
    sub = match[4];
  const method = request.method;
  if (version === undefined) {
    if (operation === "file" && method === "GET") {
      const { row, data } = await media.adminFile(actor, id);
      return new Response(data, { headers: fileHeaders(row.mime, data.length) });
    }
    if (operation === "replace" && method === "POST")
      return Response.json(await media.replace(actor, id, await readBody()), {
        status: 201,
      });
    if (operation === "versions" && method === "GET") {
      const history = await media.versions(actor, id);
      const site = history.media.siteId;
      const published = new Set(await content.publishedMediaVersions(site, id));
      const versions = [];
      for (const item of history.versions)
        versions.push({
          ...item,
          published: published.has(item.version),
          pinned: await content.mediaVersionPinned(site, id, item.version),
        });
      return Response.json({ media: history.media, versions });
    }
    if (!operation && method === "DELETE") {
      const item = await media.get(actor, id, true);
      const usage = await content.mediaUsage(item.siteId, id);
      if (usage.published || usage.draft)
        throw new HttpError(409, "图片仍被已发布内容或草稿引用");
      for (const entry of (await media.versions(actor, id)).versions)
        if (await content.mediaVersionPinned(item.siteId, id, entry.version))
          throw new HttpError(
            409,
            `图片的第 ${entry.version} 版仍被发布记录引用（含已下架内容），不能删除`,
          );
      await media.remove(actor, id, async (client) => {
        const usage = await content.mediaUsage(item.siteId, id, client);
        if (usage.published || usage.draft)
          throw new HttpError(409, "图片仍被已发布内容或草稿引用");
        for (const entry of (await media.versions(actor, id)).versions)
          if (await content.mediaVersionPinned(item.siteId, id, entry.version, client))
            throw new HttpError(
              409,
              `图片的第 ${entry.version} 版仍被发布记录引用（含已下架内容），不能删除`,
            );
      });
      return Response.json({ ok: true });
    }
    return null;
  }
  if (operation !== "versions") return null;
  if (version < 1) throw new HttpError(404, "媒体版本不存在");
  if (sub === "file" && method === "GET") {
    const { row, data } = await media.versionFile(actor, id, version);
    return new Response(data, { headers: fileHeaders(row.mime, data.length) });
  }
  if (sub === "restore" && method === "POST") {
    z.strictObject({}).parse(await readBody());
    return Response.json(await media.restore(actor, id, version));
  }
  if (!sub && method === "DELETE") {
    const item = await media.get(actor, id, true);
    if (item.version === version) throw new HttpError(409, "不能删除当前版本");
    if (await content.mediaVersionPinned(item.siteId, id, version))
      throw new HttpError(
        409,
        `第 ${version} 版仍被发布记录引用（含已下架内容），不能删除`,
      );
    await media.removeVersion(actor, id, version, async (client) => {
      if (await content.mediaVersionPinned(item.siteId, id, version, client))
        throw new HttpError(
          409,
          `第 ${version} 版仍被发布记录引用（含已下架内容），不能删除`,
        );
    });
    return Response.json({ ok: true });
  }
  return null;
}
