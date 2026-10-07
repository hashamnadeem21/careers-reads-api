import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * Every error the API returns has this shape. `fields` maps a form field path to its first problem;
 * `details` carries extra data for a specific code (e.g. where an image is still used).
 */
export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string>; details?: unknown };
}

/** Throw from anywhere to return a specific code/message (e.g. `new ApiError(409, "slug_taken", "…")`). */
export class ApiError extends HttpException {
  constructor(status: HttpStatus, code: string, message: string, fields?: Record<string, string>, details?: unknown) {
    super(
      {
        error: { code, message, ...(fields ? { fields } : {}), ...(details !== undefined ? { details } : {}) },
      } satisfies ApiErrorBody,
      status,
    );
  }
}
