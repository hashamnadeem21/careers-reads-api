import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import type { AuthUser } from "../auth/auth-user.js";
import { CurrentUser, StaffOnly, SuperAdminOnly } from "../auth/decorators.js";
import { ApiZodBody, formBody, ZodPipe } from "../common/zod.js";
import { testSendSchema } from "../newsletters/newsletters.schemas.js";
import { type AutomationBody, automationBodySchema, automationStatusSchema } from "./automations.schemas.js";
import { AutomationsService } from "./automations.service.js";

const idParam = new ZodPipe(z.coerce.number().int().positive("Not a valid id"));

@ApiTags("automations")
@Controller("automations")
@StaffOnly()
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  /** Every automation (no bodies) with delivery `stats`, plus `sendingReady`. */
  @Get()
  list() {
    return this.automations.list();
  }

  /** New automations start switched off. */
  @Post()
  @ApiZodBody(automationBodySchema)
  create(@CurrentUser() user: AuthUser, @Body(formBody(automationBodySchema)) body: AutomationBody) {
    return this.automations.create(user, body);
  }

  /** The automation, `stats`, top `failures`, the latest 25 deliveries (`recent`) and `sendingReady`. */
  @Get(":id")
  get(@Param("id", idParam) id: number) {
    return this.automations.get(id);
  }

  @Patch(":id")
  @ApiZodBody(automationBodySchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("id", idParam) id: number,
    @Body(formBody(automationBodySchema)) body: AutomationBody,
  ) {
    return this.automations.update(user, id, body);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthUser, @Param("id", idParam) id: number): Promise<void> {
    await this.automations.remove(user, id);
  }

  /** Switches it on or off. Super admins only. 503 `email_not_configured` when turning on without Resend. */
  @Post(":id/status")
  @HttpCode(HttpStatus.OK)
  @SuperAdminOnly()
  @ApiZodBody(automationStatusSchema)
  setStatus(
    @CurrentUser() user: AuthUser,
    @Param("id", idParam) id: number,
    @Body(new ZodPipe(automationStatusSchema)) body: z.infer<typeof automationStatusSchema>,
  ) {
    return this.automations.setActive(user, id, body.active);
  }

  /** Sends the saved email to one address (default: yours). */
  @Post(":id/test")
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(testSendSchema)
  sendTest(
    @CurrentUser() user: AuthUser,
    @Param("id", idParam) id: number,
    @Body(new ZodPipe(testSendSchema)) body: z.infer<typeof testSendSchema>,
  ) {
    return this.automations.sendTest(user, id, body.email);
  }

  /** Tries the emails that failed for good again. Super admins only. */
  @Post(":id/retry")
  @HttpCode(HttpStatus.ACCEPTED)
  @SuperAdminOnly()
  retry(@CurrentUser() user: AuthUser, @Param("id", idParam) id: number) {
    return this.automations.retryFailed(user, id);
  }
}
