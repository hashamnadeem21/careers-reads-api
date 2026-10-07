import { z } from "zod";
import { ZodPipe } from "./zod.js";

/** `@Param("id", uuidParam) id: string`: a malformed id is a 400, not a database error. */
export const uuidParam = new ZodPipe(z.uuid("Not a valid id"));
