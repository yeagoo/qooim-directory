import { z } from "zod";
import type { AiService } from "./ai.js";
import { HttpError, type Operator } from "./operators.js";

export async function aiHttp(
  ai: AiService,
  actor: Operator,
  action: string,
  request: Request,
  body: () => Promise<unknown>,
) {
  if (action === "/ai/config" && request.method === "GET") {
    const site = z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,47}$/)
      .parse(new URL(request.url).searchParams.get("site"));
    return Response.json(await ai.config(actor, site));
  }
  if (action === "/ai/usage" && request.method === "GET") {
    const site = z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,47}$/)
      .parse(new URL(request.url).searchParams.get("site"));
    return Response.json(await ai.usage(actor, site));
  }
  if (action === "/ai/config" && request.method === "POST")
    return Response.json(await ai.saveConfig(actor, await body()));
  if (action === "/ai/jobs" && request.method === "POST")
    return Response.json(await ai.create(actor, await body()), { status: 201 });
  const match = action.match(/^\/ai\/jobs\/([0-9a-f-]{36})$/);
  if (match && request.method === "GET") {
    const site = z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,47}$/)
      .parse(new URL(request.url).searchParams.get("site"));
    return Response.json(await ai.job(actor, site, match[1]!));
  }
  if (action.startsWith("/ai/")) throw new HttpError(405, "Method not allowed");
  return null;
}
