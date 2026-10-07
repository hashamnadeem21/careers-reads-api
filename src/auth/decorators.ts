import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { applyDecorators } from "@nestjs/common";
import type { Request } from "express";
import type { Role } from "../db/schema.js";
import { STAFF_ROLES, type AuthUser } from "./auth-user.js";

export const IS_PUBLIC = "auth:public";
export const ROLES = "auth:roles";
export const ALLOW_PASSWORD_CHANGE_PENDING = "auth:allow-password-change-pending";

/** No sign-in needed (login, invites, and everything the website calls). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Only these roles. Without it, any signed-in user (including company accounts) gets through. */
export const Roles = (...roles: Role[]) => applyDecorators(SetMetadata(ROLES, roles), ApiBearerAuth());

/** Career Reads staff (super admins and editors). Company accounts get a 403. */
export const StaffOnly = () => Roles(...STAFF_ROLES);

/** The owner only: users, companies, settings. */
export const SuperAdminOnly = () => Roles("super_admin");

/** Reachable before a temporary password has been replaced (me, change password, logout). */
export const AllowPasswordChangePending = () => SetMetadata(ALLOW_PASSWORD_CHANGE_PENDING, true);

/** The signed-in user (set by AuthGuard). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser =>
    context.switchToHttp().getRequest<Request & { user: AuthUser }>().user,
);
