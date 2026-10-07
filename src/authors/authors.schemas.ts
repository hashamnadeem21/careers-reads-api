import { z } from "zod";

const text = (max: number) => z.string().max(max).default("");

/** The admin's author form. Checked with the site's `authorSchema` in the service. */
export const authorBodySchema = z.object({
  slug: text(80),
  name: text(200),
  type: z.enum(["Person", "Organization"]).default("Person"),
  role: text(200),
  bio: text(2000),
  avatar: text(500),
  links: z
    .object({ website: text(500), x: text(500), linkedin: text(500) })
    .partial()
    .default({}),
});
export type AuthorBody = z.infer<typeof authorBodySchema>;
