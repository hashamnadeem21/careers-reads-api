import { z } from "zod";
import { SLUG_PATTERN } from "../shared/content/schema.js";
import { ZodPipe } from "./zod.js";

/** `@Param("id", uuidParam) id: string`: a malformed id is a 400, not a database error. */
export const uuidParam = new ZodPipe(z.uuid("Not a valid id"));

/** `@Param("slug", slugParam) slug: string`: lowercase kebab-case, like every post, job and author slug. */
export const slugParam = new ZodPipe(z.string().regex(SLUG_PATTERN, "Not a valid slug"));
