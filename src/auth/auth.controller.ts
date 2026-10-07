import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import type { z } from "zod";
import { clientIp } from "../common/request.js";
import { ApiZodBody, ZodPipe } from "../common/zod.js";
import { type AuthUser, publicUser } from "./auth-user.js";
import { changePasswordSchema, loginSchema, refreshSchema } from "./auth.schemas.js";
import { AuthService, type SignedIn } from "./auth.service.js";
import { AllowPasswordChangePending, CurrentUser, Public } from "./decorators.js";
import { SessionsService } from "./sessions.service.js";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
  ) {}

  /** Email + password → access token (15 min) + refresh token (30 days). Rate-limited per IP and per account. */
  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(loginSchema)
  login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>, @Req() request: Request): Promise<SignedIn> {
    return this.auth.login(body, clientIp(request));
  }

  /** Trades a refresh token for a new pair. Reusing an already-rotated token signs that user out everywhere. */
  @Public()
  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(refreshSchema)
  refresh(@Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>): Promise<SignedIn> {
    return this.auth.refresh(body.refreshToken);
  }

  /** Ends the session the refresh token belongs to. Always 204, even for unknown tokens. */
  @Public()
  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiZodBody(refreshSchema)
  async logout(@Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>): Promise<void> {
    await this.sessions.revoke(body.refreshToken);
  }

  @Get("me")
  @ApiBearerAuth()
  @AllowPasswordChangePending()
  me(@CurrentUser() user: AuthUser) {
    return { user: publicUser(user) };
  }

  /** Signs out every other device and returns a new token pair for this one. */
  @Post("change-password")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @AllowPasswordChangePending()
  @ApiZodBody(changePasswordSchema)
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
  ): Promise<SignedIn> {
    return this.auth.changePassword(user, body);
  }
}
