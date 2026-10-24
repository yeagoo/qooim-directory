import { z } from "zod";
import type { Distribution } from "./distribution.js";
import { HttpError, type Operator } from "./operators.js";
// M18 routes: personas, distributions and their tasks, schedules, bulk actions.
export async function distributionHttp(
  distribution: Distribution,
  actor: Operator,
  path: string,
  request: Request,
  body: () => Promise<unknown>,
): Promise<Response | null> {
  const get = request.method === "GET",
    json = Response.json,
    query = new URL(request.url).searchParams;
  const persona = path.match(/^\/personas\/([a-z][a-z0-9-]{0,47})$/);
  if (persona)
    return json(
      get
        ? await distribution.persona(actor, persona[1])
        : await distribution.savePersona(actor, persona[1], await body()),
    );
  if (path === "/distributions")
    return json(
      get
        ? await distribution.list(actor, query.get("resource") ?? "")
        : await distribution.create(actor, await body()),
      { status: get ? 200 : 201 },
    );
  const one = path.match(/^\/distributions\/([0-9a-f-]{36})$/);
  if (one && get) return json(await distribution.detail(actor, one[1]));
  const task = path.match(
    /^\/distribution-tasks\/([0-9a-f-]{36})\/(cancel|retry|approve|prompt|paste)$/,
  );
  if (task) {
    const [, id, action] = task;
    if (action === "prompt") {
      if (!get) throw new HttpError(405, "方法不允许");
      return json(await distribution.prompt(actor, id));
    }
    if (get) throw new HttpError(405, "方法不允许");
    if (action === "cancel") return json(await distribution.cancel(actor, id));
    if (action === "retry") return json(await distribution.retry(actor, id));
    if (action === "approve") return json(await distribution.approve(actor, id, await body()));
    return json(await distribution.paste(actor, id, await body()));
  }
  if (path === "/distribution/matrix" && get)
    return json(await distribution.matrix(actor, query.get("resource") ?? ""));
  if (path === "/distribution/missing" && get)
    return json(await distribution.missing(actor, query.get("site") ?? ""));
  if (path === "/distribution/unpublish" && !get)
    return json(await distribution.unpublishEverywhere(actor, await body()));
  if (path === "/distribution/primary" && !get)
    return json(await distribution.setPrimary(actor, await body()));
  if (path === "/schedules")
    return json(
      get
        ? await distribution.schedules(actor, z.string().parse(query.get("site") ?? ""))
        : await distribution.setSchedule(actor, await body()),
    );
  return null;
}
