import { Controller, Delete, Get, Param, Query, Res } from "@nestjs/common";
import { ApiProduces, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { AuthUser } from "../auth/auth-user.js";
import { CurrentUser, SuperAdminOnly } from "../auth/decorators.js";
import { uuidParam } from "../common/params.js";
import { ApiZodQuery, ZodPipe } from "../common/zod.js";
import { type CandidateListQuery, candidateListQuerySchema, CandidatesAdminService } from "./candidates-admin.service.js";

const exportQuerySchema = candidateListQuerySchema.omit({ page: true });

/** Candidate accounts (people who signed up on the website to apply). Super admins only. */
@ApiTags("candidates")
@Controller("candidates")
@SuperAdminOnly()
export class CandidatesAdminController {
  constructor(private readonly candidates: CandidatesAdminService) {}

  /** One page (25), newest sign-ups first, with totals for the stat cards. */
  @Get()
  @ApiZodQuery(candidateListQuerySchema)
  list(@Query(new ZodPipe(candidateListQuerySchema)) query: CandidateListQuery) {
    return this.candidates.list(query);
  }

  /** CSV of every account matching the filters. "Subscribed to newsletter" = agreed to marketing email. */
  @Get("export")
  @ApiZodQuery(exportQuerySchema)
  @ApiProduces("text/csv")
  async export(
    @CurrentUser() user: AuthUser,
    @Query(new ZodPipe(exportQuerySchema)) query: Omit<CandidateListQuery, "page">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const csv = await this.candidates.exportCsv(user, query);
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="candidates-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "private, no-store",
    });
    return `﻿${csv}`; // the BOM makes Excel read it as UTF-8
  }

  /** One candidate: profile, sign-in/apply history and applications. */
  @Get(":id")
  get(@Param("id", uuidParam) id: string) {
    return this.candidates.get(id);
  }

  @Delete(":id")
  remove(@CurrentUser() user: AuthUser, @Param("id", uuidParam) id: string) {
    return this.candidates.remove(user, id);
  }
}
