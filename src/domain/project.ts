import type { PublicProject } from "../public/sdk.js";
import { z } from "zod";
export const repositoryName = z
  .string()
  .max(140)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/,
  )
  .refine((v) => ![".", ".."].includes(v.split("/")[1]));
export const projectSchema = z.strictObject({
  provider: z.literal("github"),
  repoId: z.string().regex(/^\d{1,20}$/),
  fullName: repositoryName,
  stars: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  forks: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  openIssues: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  language: z.string().max(100).nullable(),
  license: z.string().max(100).nullable(),
  topics: z.array(z.string().max(100)).max(30),
  archived: z.boolean(),
  pushedAt: z.iso.datetime().nullable(),
}) satisfies z.ZodType<PublicProject>;
export type Project = z.infer<typeof projectSchema>;
export const sourceFields = z
  .array(
    z.enum([
      "project",
      "url",
      "source",
      "translations.en.title",
      "translations.en.description",
    ]),
  )
  .min(1)
  .max(5)
  .refine((v) => new Set(v).size === v.length);
