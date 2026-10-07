import { Injectable, Logger, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

/** One line per request: method, path, status, duration. Never logs bodies, headers or query strings. */
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger("HTTP");

  use(request: Request, response: Response, next: NextFunction): void {
    const started = process.hrtime.bigint();
    response.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const line = `${request.method} ${request.baseUrl}${request.path} ${response.statusCode} ${ms.toFixed(1)}ms`;
      if (response.statusCode >= 500) this.logger.error(line);
      else this.logger.log(line);
    });
    next();
  }
}
