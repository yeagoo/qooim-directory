import { z } from "zod";
import { Content } from "./content.js";
import { HttpError, type Operator } from "./operators.js";
import { Conflict } from "../domain/config.js";
export async function contentHttp(
  content: Content,
  actor: Operator,
  path: string,
  request: Request,
  body: () => Promise<unknown>,
): Promise<Response | null> {
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(100000)
    .parse(new URL(request.url).searchParams.get("page") ?? 1);
  const get = request.method === "GET",
    json = Response.json;
  if (path === "/resources")
    return json(
      get
        ? await content.resources(
            actor,
            new URL(request.url).searchParams.get("q") ?? "",
            page,
          )
        : { version: await content.saveResource(actor, await body()) },
    );
  if (path === "/resources/exchange") {
    if (get)
      return json(
        await content.exportResources(
          actor,
          new URL(request.url).searchParams.get("q") ?? "",
          page,
        ),
      );
    const input = z
      .strictObject({ bundle: z.unknown(), apply: z.boolean().default(false) })
      .parse(await body());
    return json(
      await content.importResources(actor, input.bundle, input.apply),
    );
  }
  if (path === "/content/batch-publish" && !get) {
    await content.operators.require(actor);
    const input = z
      .strictObject({
        items: z
          .array(
            z.strictObject({
              siteId: z.string(),
              resourceId: z.string(),
              locale: z.enum(["zh", "en"]),
              expected: z.object({
                published: z.number().int().nonnegative(),
                draft: z.number().int().nonnegative(),
              }),
              operationId: z.uuid(),
            }),
          )
          .min(1)
          .max(20),
      })
      .parse(await body());
    const results = [];
    for (const item of input.items) {
      try {
        results.push({
          siteId: item.siteId,
          resourceId: item.resourceId,
          locale: item.locale,
          ok: true,
          version: await content.publish(
            actor,
            item.siteId,
            item.resourceId,
            item.locale,
            { expected: item.expected, operationId: item.operationId },
          ),
        });
      } catch (error) {
        results.push({
          siteId: item.siteId,
          resourceId: item.resourceId,
          locale: item.locale,
          ok: false,
          error:
            error instanceof HttpError || error instanceof Conflict
              ? error.message
              : "发布失败",
        });
      }
    }
    return json({ results });
  }
  const resource = path.match(/^\/resources\/([a-z][a-z0-9-]{0,63})$/);
  if (resource && get)
    return json(await content.resourceHistory(actor, resource[1]));
  const match = path.match(
    /^\/content\/([a-z][a-z0-9-]{0,47})\/(publications|categories|submissions)$/,
  );
  if (match) {
    const [, site, kind] = match;
    if (kind === "publications" && get)
      return json(await content.publications(actor, site, page));
    if (kind === "categories")
      return json(
        get
          ? await content.categories(actor, site)
          : { version: await content.saveCategory(actor, site, await body()) },
      );
    if (kind === "submissions" && get)
      return json(await content.submissions(actor, site, page));
    throw new HttpError(405, "Method not allowed");
  }
  const review = path.match(
    /^\/content\/([a-z][a-z0-9-]{0,47})\/submissions\/([0-9a-f-]+)$/,
  );
  if (review && !get)
    return json(
      await content.review(actor, review[1], review[2], await body()),
    );
  const action = path.match(
    /^\/content\/([a-z][a-z0-9-]{0,47})\/([a-z][a-z0-9-]{0,63})\/(zh|en)\/(stage|publish|unpublish|preview|diagnose|history|diff)$/,
  );
  if (!action) return null;
  const [, site, id, locale, operation] = action;
  if (get) {
    if (operation === "diff")
      return json(await content.updateDiff(actor, site, id, locale));
    if (operation === "preview")
      return json(await content.preview(actor, site, id, locale));
    if (operation === "diagnose")
      return json(await content.diagnose(actor, site, id, locale));
    if (operation === "history")
      return json(await content.publicationHistory(actor, site, id, locale));
  } else {
    const input = await body();
    if (operation === "stage")
      return json({
        draftVersion: await content.stage(actor, site, id, locale, input),
      });
    if (operation === "publish")
      return json({
        version: await content.publish(actor, site, id, locale, input),
      });
    if (operation === "unpublish") {
      const value = z
        .strictObject({ expectedVersion: z.number().int().nonnegative() })
        .parse(input);
      return json({
        version: await content.unpublish(
          actor,
          site,
          id,
          locale,
          value.expectedVersion,
        ),
      });
    }
  }
  throw new HttpError(405, "Method not allowed");
}
