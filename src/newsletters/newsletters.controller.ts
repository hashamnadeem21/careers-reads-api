import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import type { AuthUser } from "../auth/auth-user.js";
import { CurrentUser, StaffOnly, SuperAdminOnly } from "../auth/decorators.js";
import { ApiZodBody, ApiZodQuery, formBody, ZodPipe } from "../common/zod.js";
import { type Audience, audienceSchema } from "./audience.js";
import {
  type NewsletterBody,
  newsletterBodySchema,
  newsletterPreviewSchema,
  type ScheduleBody,
  scheduleSchema,
  type SendBody,
  sendSchema,
  testSendSchema,
} from "./newsletters.schemas.js";
import { NewslettersService } from "./newsletters.service.js";

const idParam = new ZodPipe(z.coerce.number().int().positive("Not a valid id"));

@ApiTags("newsletters")
@Controller("newsletters")
@StaffOnly()
export class NewslettersController {
  constructor(private readonly newsletters: NewslettersService) {}

  /** Newest 200 (no bodies), with `activeSubscribers` and `sendingReady`. */
  @Get()
  list() {
    return this.newsletters.list();
  }

  @Post()
  @ApiZodBody(newsletterBodySchema)
  create(@CurrentUser() user: AuthUser, @Body(formBody(newsletterBodySchema)) body: NewsletterBody) {
    return this.newsletters.create(user, body);
  }

  /** Renders unsaved edits as the email subscribers will get: `{ html }`. */
  @Post("preview")
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(newsletterPreviewSchema)
  preview(@Body(new ZodPipe(newsletterPreviewSchema)) body: NewsletterBody) {
    return this.newsletters.preview(body);
  }

  /** How many active subscribers signed up in [from, to): `{ count }`. Both empty = everyone. */
  @Get("audience")
  @ApiZodQuery(audienceSchema)
  audience(@Query(new ZodPipe(audienceSchema)) query: Audience) {
    return this.newsletters.audienceSize(query);
  }

  /** The newsletter, plus `activeSubscribers`, `sendingReady` and the top delivery `failures`. */
  @Get(":id")
  get(@Param("id", idParam) id: number) {
    return this.newsletters.get(id);
  }

  /** Drafts and scheduled newsletters only (409 `already_sent` otherwise). */
  @Patch(":id")
  @ApiZodBody(newsletterBodySchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("id", idParam) id: number,
    @Body(formBody(newsletterBodySchema)) body: NewsletterBody,
  ) {
    return this.newsletters.update(user, id, body);
  }

  /** 409 `sending` while it's going out. */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthUser, @Param("id", idParam) id: number): Promise<void> {
    await this.newsletters.remove(user, id);
  }

  /** Sends the saved draft to one address (default: yours). 503 `email_not_configured` without Resend. */
  @Post(":id/test")
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(testSendSchema)
  sendTest(
    @CurrentUser() user: AuthUser,
    @Param("id", idParam) id: number,
    @Body(new ZodPipe(testSendSchema)) body: z.infer<typeof testSendSchema>,
  ) {
    return this.newsletters.sendTest(user, id, body.email);
  }

  /** Sends now to the audience (default: every active subscriber), in the background. Super admins only. */
  @Post(":id/send")
  @HttpCode(HttpStatus.ACCEPTED)
  @SuperAdminOnly()
  @ApiZodBody(sendSchema)
  send(@CurrentUser() user: AuthUser, @Param("id", idParam) id: number, @Body(formBody(sendSchema)) body: SendBody) {
    return this.newsletters.send(user, id, body.audience);
  }

  /** Sends automatically at `sendAt` to the audience. Rescheduling is fine. Super admins only. */
  @Post(":id/schedule")
  @HttpCode(HttpStatus.OK)
  @SuperAdminOnly()
  @ApiZodBody(scheduleSchema)
  schedule(
    @CurrentUser() user: AuthUser,
    @Param("id", idParam) id: number,
    @Body(formBody(scheduleSchema)) body: ScheduleBody,
  ) {
    return this.newsletters.schedule(user, id, body);
  }

  /** Back to a draft. 409 `not_scheduled` if it isn't (or has started sending). Super admins only. */
  @Delete(":id/schedule")
  @SuperAdminOnly()
  unschedule(@CurrentUser() user: AuthUser, @Param("id", idParam) id: number) {
    return this.newsletters.unschedule(user, id);
  }

  /** Tries a sent newsletter's failed deliveries again. Super admins only. */
  @Post(":id/retry")
  @HttpCode(HttpStatus.ACCEPTED)
  @SuperAdminOnly()
  retry(@CurrentUser() user: AuthUser, @Param("id", idParam) id: number) {
    return this.newsletters.retryFailed(user, id);
  }
}
