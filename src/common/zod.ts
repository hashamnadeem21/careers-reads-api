import { applyDecorators, HttpStatus, type PipeTransform } from "@nestjs/common";
import { ApiBody, ApiQuery } from "@nestjs/swagger";
import { z } from "zod";
import { ApiError } from "./api-error.js";

/** `{ "title": "Too short", "images.0.alt": "Required" }`: first problem per field, keyed by path. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join(".") : "_";
    fields[key] ??= issue.message;
  }
  return fields;
}

/**
 * Validates and parses a request part with a Zod schema; the handler receives the parsed value.
 * Usage: `@Body(new ZodPipe(schema)) body: z.infer<typeof schema>`
 */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        "validation_failed",
        "Some fields are invalid.",
        fieldErrors(parsed.error),
      );
    }
    return parsed.data;
  }
}

/** JSON Schema for OpenAPI, describing what the endpoint accepts. */
function toOpenApi(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  return json;
}

/** Documents a Zod-validated JSON body in Swagger. Pair with `@Body(new ZodPipe(schema))`. */
export const ApiZodBody = (schema: z.ZodType) => ApiBody({ schema: toOpenApi(schema) });

/** Documents each property of a Zod object as a query parameter. Pair with `@Query(new ZodPipe(schema))`. */
export function ApiZodQuery(schema: z.ZodObject) {
  const json = toOpenApi(schema) as { properties?: Record<string, object>; required?: string[] };
  return applyDecorators(
    ...Object.entries(json.properties ?? {}).map(([name, property]) =>
      ApiQuery({ name, required: json.required?.includes(name) ?? false, schema: property }),
    ),
  );
}
