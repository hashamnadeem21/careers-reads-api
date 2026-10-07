import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  UseGuards,
} from "@nestjs/common";
import { ApiSecurity } from "@nestjs/swagger";
import type { Request } from "express";
import { Public } from "../auth/decorators.js";
import { ApiError } from "./api-error.js";
import { trustedCaller } from "./request.js";

/** Lets a request through only when it carries the website's `X-Api-Key`. */
@Injectable()
export class SiteKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (trustedCaller(context.switchToHttp().getRequest<Request>()) !== "site") {
      throw new ApiError(HttpStatus.FORBIDDEN, "site_key_required", "Only the website may call this.");
    }
    return true;
  }
}

/** No sign-in, but the website's server key is required (form submissions, stats). */
export const SiteOnly = () => applyDecorators(Public(), UseGuards(SiteKeyGuard), ApiSecurity("api-key"));

/** True when the request comes from the website's server (drafts may be previewed). */
export const isSiteRequest = (request: Request): boolean => trustedCaller(request) === "site";
