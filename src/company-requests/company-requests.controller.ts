import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import type { z } from "zod";
import type { AuthUser } from "../auth/auth-user.js";
import { CurrentUser, SuperAdminOnly } from "../auth/decorators.js";
import { uuidParam } from "../common/params.js";
import { clientIp } from "../common/request.js";
import { SiteOnly } from "../common/site-key.guard.js";
import { ApiZodBody, ApiZodQuery, ZodPipe } from "../common/zod.js";
import {
  approveCompanyRequestSchema,
  companyRequestListQuerySchema,
  companyRequestSchema,
  rejectCompanyRequestSchema,
} from "./company-requests.schemas.js";
import { CompanyRequestsService } from "./company-requests.service.js";

/** The website's "For employers" form. Website server only (site key); 3 per visitor per hour. */
@ApiTags("public")
@Controller("public/company-requests")
export class CompanyRequestsPublicController {
  constructor(private readonly requests: CompanyRequestsService) {}

  @Post()
  @SiteOnly()
  @HttpCode(HttpStatus.CREATED)
  @ApiZodBody(companyRequestSchema)
  submit(@Req() request: Request, @Body(new ZodPipe(companyRequestSchema)) body: z.infer<typeof companyRequestSchema>) {
    return this.requests.submit(clientIp(request), body);
  }
}

/** Reviewing company account requests. Super admins only. */
@ApiTags("company-requests")
@ApiBearerAuth()
@Controller("company-requests")
@SuperAdminOnly()
export class CompanyRequestsController {
  constructor(private readonly requests: CompanyRequestsService) {}

  /** 25 per page: waiting ones oldest first, the rest newest first. `counts` covers every status. */
  @Get()
  @ApiZodQuery(companyRequestListQuerySchema)
  list(@Query(new ZodPipe(companyRequestListQuerySchema)) query: z.infer<typeof companyRequestListQuerySchema>) {
    return this.requests.list(query);
  }

  @Get("pending-count")
  async pendingCount(): Promise<{ count: number }> {
    return { count: await this.requests.pendingCount() };
  }

  /** The request, who reviewed it, and checks for the reviewer (email already has an account, name taken). */
  @Get(":id")
  get(@Param("id", uuidParam) id: string) {
    return this.requests.get(id);
  }

  /** Creates the company and emails the contact an invite to its first admin account. 409 `already_reviewed`, `already_member`, `name_taken`. */
  @Post(":id/approve")
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(approveCompanyRequestSchema)
  approve(
    @CurrentUser() admin: AuthUser,
    @Param("id", uuidParam) id: string,
    @Body(new ZodPipe(approveCompanyRequestSchema)) body: z.infer<typeof approveCompanyRequestSchema>,
  ) {
    return this.requests.approve(admin, id, body);
  }

  /** Turns it down; with `notify`, emails them (and the reason, if given). 409 `already_reviewed`. */
  @Post(":id/reject")
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(rejectCompanyRequestSchema)
  reject(
    @CurrentUser() admin: AuthUser,
    @Param("id", uuidParam) id: string,
    @Body(new ZodPipe(rejectCompanyRequestSchema)) body: z.infer<typeof rejectCompanyRequestSchema>,
  ) {
    return this.requests.reject(admin, id, body);
  }
}
