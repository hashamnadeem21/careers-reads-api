import { HttpException, HttpStatus } from "@nestjs/common";

/** Every error the API returns has this shape. `fields` maps a form field path to its first problem. */
export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string> };
}

/** Throw from anywhere to return a specific code/message (e.g. `new ApiError(409, "slug_taken", "…")`). */
export class ApiError extends HttpException {
  constructor(status: HttpStatus, code: string, message: string, fields?: Record<string, string>) {
    super({ error: { code, message, ...(fields ? { fields } : {}) } } satisfies ApiErrorBody, status);
  }
}
