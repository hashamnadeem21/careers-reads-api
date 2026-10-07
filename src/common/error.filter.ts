import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Response } from "express";
import type { ApiErrorBody } from "./api-error.js";

const CODES: Partial<Record<number, string>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "rate_limited",
};

function isApiErrorBody(body: unknown): body is ApiErrorBody {
  return typeof body === "object" && body !== null && "error" in body && typeof body.error === "object";
}

/** Turns every thrown error into `{ error: { code, message, fields? } }`. Unknown errors never leak details. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("Error");

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (isApiErrorBody(body)) {
        response.status(status).json(body);
        return;
      }
      const message =
        typeof body === "string"
          ? body
          : typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
            ? body.message
            : exception.message;
      response.status(status).json({ error: { code: CODES[status] ?? "error", message } } satisfies ApiErrorBody);
      return;
    }

    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ error: { code: "internal_error", message: "Something went wrong." } } satisfies ApiErrorBody);
  }
}
