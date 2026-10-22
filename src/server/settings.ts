import { z } from "zod";
import { authPolicy } from "./auth-policy.js";
import { retentionPolicy } from "./retention.js";
export function settings() {
  if (process.env.GITHUB_SYNC_TOKEN)
    z.string()
      .min(1)
      .max(500)
      .regex(/^[\x21-\x7e]+$/)
      .parse(process.env.GITHUB_SYNC_TOKEN);
  const adminOrigin = z.url().parse(process.env.ADMIN_ORIGIN);
  const url = new URL(adminOrigin);
  if (url.origin !== adminOrigin || !["http:", "https:"].includes(url.protocol))
    throw new Error("ADMIN_ORIGIN must be an origin");
  const development = process.env.ALLOW_INSECURE_HTTP === "true";
  if (url.protocol !== "https:" && !development)
    throw new Error("HTTPS required");
  const key = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(process.env.AUTH_ENCRYPTION_KEY);
  return {
    auth: authPolicy(),
    databaseUrl: z.string().min(1).parse(process.env.DATABASE_URL),
    adminOrigin,
    key,
    development,
    mediaRoot: process.env.MEDIA_ROOT || ".local/media",
    retention: retentionPolicy(process.env),
  };
}
