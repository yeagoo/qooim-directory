import { z } from "zod";
import { isIP } from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { digest } from "./crypto.js";
import { HttpError } from "./operators.js";

export type AuthPolicy = {
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    password?: string;
    from: string;
    allowInsecure: boolean;
  };
  requireEmail: boolean;
  proxyToken?: string;
  sessionSeconds: number;
  updateSeconds: number;
  absoluteSeconds: number;
  historyDays: number;
  // OIDC issuers and user-info endpoints must resolve to public addresses unless
  // this is set (private identity providers on an internal network, tests).
  oidcAllowPrivate?: boolean;
};

export function authPolicy(
  env: Record<string, string | undefined> = process.env,
): AuthPolicy {
  const flag = (name: string, fallback = "false") =>
    z.enum(["true", "false"]).parse(env[name] ?? fallback) === "true";
  const production = env.NODE_ENV === "production";
  const smtp = env.SMTP_HOST
    ? {
        host: env.SMTP_HOST,
        port: z.coerce.number().int().min(1).max(65535).parse(env.SMTP_PORT ?? 587),
        secure: flag("SMTP_SECURE"),
        user: env.SMTP_USER || undefined,
        password: env.SMTP_PASSWORD || undefined,
        from: z.email().parse(env.MAIL_FROM),
        allowInsecure: flag("SMTP_ALLOW_INSECURE"),
      }
    : undefined;
  if (smtp && !!smtp.user !== !!smtp.password)
    throw new Error("SMTP_USER and SMTP_PASSWORD must be configured together");
  if (
    smtp?.allowInsecure &&
    !["127.0.0.1", "localhost", "::1", "mailpit"].includes(smtp.host)
  )
    throw new Error(
      "Insecure SMTP is restricted to explicit local development receivers",
    );

  // Production defaults to verified email; a deliberate false is still
  // possible for private/trusted deployments but requires SMTP to be absent.
  const requireEmail = flag(
    "AUTH_REQUIRE_EMAIL",
    production ? "true" : "false",
  );
  if (requireEmail && !smtp)
    throw new Error("Email verification requires configured SMTP");

  const proxyToken = env.PROXY_TRUST_TOKEN || undefined;
  if (proxyToken) z.string().min(32).max(128).parse(proxyToken);
  else if (production)
    throw new Error(
      "PROXY_TRUST_TOKEN is required in production; without it every client shares the untrusted rate-limit bucket",
    );
  else
    console.warn(
      "PROXY_TRUST_TOKEN is not configured; all clients share the untrusted rate-limit bucket",
    );

  return {
    smtp,
    requireEmail,
    proxyToken,
    sessionSeconds: 604800,
    updateSeconds: 86400,
    absoluteSeconds: 2592000,
    historyDays: z.coerce
      .number()
      .int()
      .min(7)
      .max(365)
      .parse(env.AUTH_HISTORY_DAYS ?? 30),
    oidcAllowPrivate: flag("OIDC_ALLOW_PRIVATE_NETWORK"),
  };
}

export function clientIp(headers: Headers, token?: string) {
  const supplied = headers.get("x-network-proxy-key") ?? "";
  const trusted =
    token &&
    Buffer.byteLength(supplied) === Buffer.byteLength(token) &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
  const value = headers.get("x-network-client-ip") ?? "";
  return trusted && isIP(value) ? value : "untrusted";
}

export class AuthLimiter {
  constructor(private pool: Pool) {}

  async consume(scope: string, key: string, max = 300, seconds = 300) {
    const value = (
      await this.pool.query(
        `INSERT INTO auth_limit VALUES($1,1,now()+$2::int*interval '1 second')
         ON CONFLICT(key) DO UPDATE
         SET attempts=CASE WHEN auth_limit.reset_at<now() THEN 1 ELSE auth_limit.attempts+1 END,
             reset_at=CASE WHEN auth_limit.reset_at<now() THEN now()+$2::int*interval '1 second' ELSE auth_limit.reset_at END
         RETURNING attempts`,
        [digest(scope + ":" + key), seconds],
      )
    ).rows[0];
    if (value.attempts > max)
      throw new HttpError(429, "请求过于频繁，请稍后再试");
  }
}
