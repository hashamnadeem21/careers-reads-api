import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { ApiError } from "../common/api-error.js";
import { uuidParam } from "../common/params.js";
import { ApiZodBody, ApiZodQuery, ZodPipe } from "../common/zod.js";
import type { AuthUser } from "../auth/auth-user.js";
import type { SignedIn } from "../auth/auth.service.js";
import { CurrentUser, Public, SuperAdminOnly } from "../auth/decorators.js";
import { type InviteCreated, InvitesService } from "./invites.service.js";
import { acceptInviteSchema, changeRoleSchema, inviteStaffSchema, revokeInviteSchema } from "./users.schemas.js";
import { UsersService } from "./users.service.js";

@ApiTags("users")
@Controller("users")
@SuperAdminOnly()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** Staff (super admins and editors) and their pending invites. Company people are under Companies. */
  @Get()
  list(@CurrentUser() me: AuthUser) {
    return this.users.listStaff(me);
  }

  @Patch(":id/role")
  @ApiZodBody(changeRoleSchema)
  changeRole(
    @CurrentUser() me: AuthUser,
    @Param("id", uuidParam) id: string,
    @Body(new ZodPipe(changeRoleSchema)) body: z.infer<typeof changeRoleSchema>,
  ) {
    return this.users.changeRole(me, id, body.role);
  }

  @Delete(":id")
  remove(@CurrentUser() me: AuthUser, @Param("id", uuidParam) id: string) {
    return this.users.remove(me, id);
  }
}

@ApiTags("users")
@Controller("invites")
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  /** Invite a staff member (super admin or editor). Returns the one-time link to send them. */
  @Post()
  @SuperAdminOnly()
  @ApiZodBody(inviteStaffSchema)
  create(
    @CurrentUser() me: AuthUser,
    @Body(new ZodPipe(inviteStaffSchema)) body: z.infer<typeof inviteStaffSchema>,
  ): Promise<InviteCreated> {
    return this.invites.create(me, { ...body, companyId: null });
  }

  /** Cancels any pending invite for this email (staff or company). */
  @Delete()
  @SuperAdminOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiZodQuery(revokeInviteSchema)
  async revoke(
    @CurrentUser() me: AuthUser,
    @Query(new ZodPipe(revokeInviteSchema)) query: z.infer<typeof revokeInviteSchema>,
  ): Promise<void> {
    await this.invites.revoke(me, query.email);
  }

  /** What the invite page shows. 404 when the link is unknown, used or expired. */
  @Public()
  @Get(":token")
  async lookup(@Param("token") token: string) {
    const invite = await this.invites.lookup(token);
    if (!invite) throw new ApiError(HttpStatus.NOT_FOUND, "invite_invalid", "This invite isn't valid.");
    return { invite };
  }

  /** The invited person picks a password and is signed in (same response as /auth/login). */
  @Public()
  @Post(":token/accept")
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(acceptInviteSchema)
  accept(
    @Param("token") token: string,
    @Body(new ZodPipe(acceptInviteSchema)) body: z.infer<typeof acceptInviteSchema>,
  ): Promise<SignedIn> {
    return this.invites.accept(token, body);
  }
}
