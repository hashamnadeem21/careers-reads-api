import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ApiError } from "../common/api-error.js";
import type { Role } from "../db/schema.js";
import type { AuthUser } from "./auth-user.js";
import { ALLOW_PASSWORD_CHANGE_PENDING, IS_PUBLIC, ROLES } from "./decorators.js";
import { SessionsService } from "./sessions.service.js";

/**
 * The ONE gate, applied to every route. Routes are private unless marked `@Public()`.
 *
 * - no or invalid token → 401 `unauthorized` (the admin then refreshes once, or signs in again)
 * - temporary password not changed yet → 403 `password_change_required`
 * - role not allowed by `@Roles()` → 403 `forbidden`
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const [scheme, token] = (request.header("authorization") ?? "").split(" ");
    const user = scheme?.toLowerCase() === "bearer" && token ? await this.sessions.authenticate(token) : null;
    if (!user) throw new ApiError(HttpStatus.UNAUTHORIZED, "unauthorized", "Please sign in.");
    request.user = user;

    if (user.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE_PENDING, targets)) {
      throw new ApiError(HttpStatus.FORBIDDEN, "password_change_required", "Choose a new password first.");
    }

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (roles?.length && !roles.includes(user.role)) {
      throw new ApiError(HttpStatus.FORBIDDEN, "forbidden", "You don't have access to this.");
    }
    return true;
  }
}
