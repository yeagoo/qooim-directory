import { z } from "zod";
import type { Collectors } from "./collectors.js";
import { HttpError, type Operator } from "./operators.js";

const uuid = "[0-9a-f-]{36}";
export async function collectorsHttp(
  collectors: Collectors,
  actor: Operator,
  action: string,
  request: Request,
  body: () => Promise<unknown>,
) {
  if (action === "/collectors" && request.method === "GET") {
    const site = new URL(request.url).searchParams.get("site") || undefined;
    return Response.json(await collectors.list(actor, site));
  }
  if (action === "/collectors" && request.method === "POST")
    return Response.json(await collectors.save(actor, await body()), {
      status: 201,
    });
  if (action === "/collector-candidates" && request.method === "GET") {
    const site = z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,47}$/)
      .parse(new URL(request.url).searchParams.get("site"));
    return Response.json(await collectors.candidates(actor, site));
  }
  const detail = action.match(new RegExp(`^/collectors/(${uuid})$`));
  if (detail && request.method === "GET")
    return Response.json(await collectors.detail(actor, detail[1]!));
  const sync = action.match(new RegExp(`^/collectors/(${uuid})/sync$`));
  if (sync && request.method === "POST") {
    const value = z.strictObject({ operationId: z.uuid() }).parse(await body());
    return Response.json(
      await collectors.enqueue(actor, sync[1]!, value.operationId),
      { status: 202 },
    );
  }
  const review = action.match(
    new RegExp(`^/collector-candidates/(${uuid})/review$`),
  );
  if (review && request.method === "POST") {
    const value = z
      .strictObject({ site: z.string(), decision: z.enum(["accept", "reject"]), expectedVersion: z.number().int().positive() })
      .parse(await body());
    return Response.json(
      await collectors.review(actor, value.site, review[1]!, value),
    );
  }
  if (action.startsWith("/collectors") || action.startsWith("/collector-candidates"))
    throw new HttpError(405, "Method not allowed");
  return null;
}
