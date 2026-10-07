import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { uuidParam } from "../common/params.js";
import { ApiZodBody, ZodPipe } from "../common/zod.js";
import type { AuthUser } from "../auth/auth-user.js";
import { CurrentUser, StaffOnly, SuperAdminOnly } from "../auth/decorators.js";
import { companySchema, inviteCompanyUserSchema, setActiveSchema } from "./companies.schemas.js";
import { CompaniesService } from "./companies.service.js";

@ApiTags("companies")
@Controller("companies")
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  /** Every company with its job counts and traffic. */
  @Get()
  @SuperAdminOnly()
  list() {
    return this.companies.list();
  }

  /** id, name and website of every company (the staff job form's picker). */
  @Get("options")
  @StaffOnly()
  options() {
    return this.companies.options();
  }

  @Get(":id")
  @StaffOnly()
  get(@Param("id", uuidParam) id: string) {
    return this.companies.get(id);
  }

  @Get(":id/people")
  @SuperAdminOnly()
  people(@Param("id", uuidParam) id: string) {
    return this.companies.people(id);
  }

  /** Headline numbers, daily traffic (365 days) and per-job performance. Super admins, or the company's own accounts. */
  @Get(":id/dashboard")
  @ApiBearerAuth()
  dashboard(@CurrentUser() user: AuthUser, @Param("id", uuidParam) id: string) {
    return this.companies.dashboard(user, id);
  }

  @Post()
  @SuperAdminOnly()
  @ApiZodBody(companySchema)
  create(@CurrentUser() admin: AuthUser, @Body(new ZodPipe(companySchema)) body: z.infer<typeof companySchema>) {
    return this.companies.create(admin, body);
  }

  @Patch(":id")
  @SuperAdminOnly()
  @ApiZodBody(companySchema)
  update(
    @CurrentUser() admin: AuthUser,
    @Param("id", uuidParam) id: string,
    @Body(new ZodPipe(companySchema)) body: z.infer<typeof companySchema>,
  ) {
    return this.companies.update(admin, id, body);
  }

  /** Pause (signs everyone at the company out) or reactivate. */
  @Post(":id/active")
  @SuperAdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(setActiveSchema)
  setActive(
    @CurrentUser() admin: AuthUser,
    @Param("id", uuidParam) id: string,
    @Body(new ZodPipe(setActiveSchema)) body: z.infer<typeof setActiveSchema>,
  ) {
    return this.companies.setActive(admin, id, body.active);
  }

  /** Deletes the company and its accounts. Its jobs stay on the site as Career Reads jobs. */
  @Delete(":id")
  @SuperAdminOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() admin: AuthUser, @Param("id", uuidParam) id: string): Promise<void> {
    await this.companies.remove(admin, id);
  }

  @Post(":id/invites")
  @SuperAdminOnly()
  @ApiZodBody(inviteCompanyUserSchema)
  invite(
    @CurrentUser() admin: AuthUser,
    @Param("id", uuidParam) id: string,
    @Body(new ZodPipe(inviteCompanyUserSchema)) body: z.infer<typeof inviteCompanyUserSchema>,
  ) {
    return this.companies.invite(admin, id, body);
  }
}
