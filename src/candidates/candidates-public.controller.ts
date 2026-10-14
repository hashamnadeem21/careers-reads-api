import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import type { z } from "zod";
import { clientIp } from "../common/request.js";
import { SiteOnly } from "../common/site-key.guard.js";
import { ApiZodBody, formBody, ZodPipe } from "../common/zod.js";
import type { CandidateRow } from "../db/schema.js";
import { CandidateAuthService } from "./candidate-auth.service.js";
import { CandidateOnly, CandidateToken, CurrentCandidate } from "./candidate.guard.js";
import {
  candidateLoginSchema,
  emailOnlySchema,
  googleSignInSchema,
  resetPasswordSchema,
  signupSchema,
  tokenSchema,
} from "./candidates.schemas.js";

/**
 * Candidate accounts, called by the website's server only (site key). Sign-in routes return a
 * session token for the website to keep in an httpOnly cookie and send back in `X-Candidate-Session`.
 */
@ApiTags("public")
@Controller("public/candidate")
export class CandidatesPublicController {
  constructor(private readonly auth: CandidateAuthService) {}

  /** "Continue with Google": the ID token from Google's button. 401 `invalid_google_token`, 503 `google_disabled`. */
  @Post("auth/google")
  @SiteOnly()
  @ApiZodBody(googleSignInSchema)
  google(@Req() request: Request, @Body(new ZodPipe(googleSignInSchema)) body: z.infer<typeof googleSignInSchema>) {
    return this.auth.withGoogle(clientIp(request), body.credential);
  }

  /** "Create account". 409 `account_exists` when the email already has an account. */
  @Post("auth/signup")
  @SiteOnly()
  @ApiZodBody(signupSchema)
  signup(@Req() request: Request, @Body(formBody(signupSchema)) body: z.infer<typeof signupSchema>) {
    return this.auth.signUp(clientIp(request), body);
  }

  /** "Sign in" with email and password. 401 `invalid_credentials`. */
  @Post("auth/login")
  @SiteOnly()
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(candidateLoginSchema)
  login(@Req() request: Request, @Body(formBody(candidateLoginSchema)) body: z.infer<typeof candidateLoginSchema>) {
    return this.auth.signIn(clientIp(request), body);
  }

  /** Emails a reset link if the address has an account. Always 204. */
  @Post("auth/forgot-password")
  @SiteOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiZodBody(emailOnlySchema)
  async forgotPassword(@Req() request: Request, @Body(formBody(emailOnlySchema)) body: z.infer<typeof emailOnlySchema>) {
    await this.auth.forgotPassword(clientIp(request), body.email);
  }

  /** New password from the emailed link; ends other sessions and signs in. 400 `invalid_token`. */
  @Post("auth/reset-password")
  @SiteOnly()
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(resetPasswordSchema)
  resetPassword(@Req() request: Request, @Body(formBody(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>) {
    return this.auth.resetPassword(clientIp(request), body.token, body.password);
  }

  /** The "Confirm your email" link. No session needed. 400 `invalid_token`. */
  @Post("auth/confirm-email")
  @SiteOnly()
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(tokenSchema)
  confirmEmail(@Body(new ZodPipe(tokenSchema)) body: z.infer<typeof tokenSchema>) {
    return this.auth.confirmEmail(body.token);
  }

  @Post("auth/resend-confirmation")
  @CandidateOnly()
  @HttpCode(HttpStatus.OK)
  resendConfirmation(@CurrentCandidate() candidate: CandidateRow) {
    return this.auth.resendConfirmation(candidate);
  }

  @Post("auth/logout")
  @CandidateOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@CurrentCandidate() candidate: CandidateRow, @CandidateToken() token: string) {
    await this.auth.signOut(candidate, token);
  }

  /** The signed-in candidate. 401 `candidate_unauthorized` when the session is missing or over. */
  @Get("me")
  @CandidateOnly()
  me(@CurrentCandidate() candidate: CandidateRow) {
    return this.auth.me(candidate);
  }

  /** "Subscribe" after applying: their own email joins the newsletter list, with no extra email. */
  @Post("subscribe")
  @CandidateOnly()
  @HttpCode(HttpStatus.OK)
  subscribe(@CurrentCandidate() candidate: CandidateRow) {
    return this.auth.subscribe(candidate);
  }

  /** "Delete my account": the account, its applications and CVs, and its newsletter subscription. */
  @Delete("me")
  @CandidateOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAccount(@CurrentCandidate() candidate: CandidateRow) {
    await this.auth.deleteAccount(candidate);
  }
}
