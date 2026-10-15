import {
  applyDecorators,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  UseGuards,
} from "@nestjs/common";
import { ApiHeader } from "@nestjs/swagger";
import type { Request } from "express";
import { ApiError } from "../common/api-error.js";
import { SiteOnly } from "../common/site-key.guard.js";
import type { CandidateRow } from "../db/schema.js";
import { CandidateSessionsService } from "./candidate-sessions.service.js";

/** The website's server forwards the candidate's session (kept in an httpOnly cookie) in this header. */
export const CANDIDATE_SESSION_HEADER = "x-candidate-session";

type CandidateRequest = Request & { candidate?: CandidateRow; candidateToken?: string };

/** A signed-in candidate, or 401 `candidate_unauthorized`. Staff tokens are not accepted. */
@Injectable()
export class CandidateGuard implements CanActivate {
  constructor(private readonly sessions: CandidateSessionsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<CandidateRequest>();
    const token = request.header(CANDIDATE_SESSION_HEADER) ?? "";
    const candidate = token ? await this.sessions.authenticate(token) : null;
    if (!candidate) throw new ApiError(HttpStatus.UNAUTHORIZED, "candidate_unauthorized", "Please sign in.");
    request.candidate = candidate;
    request.candidateToken = token;
    return true;
  }
}

/** Website-only route that needs a signed-in candidate. */
export const CandidateOnly = () =>
  applyDecorators(
    SiteOnly(),
    UseGuards(CandidateGuard),
    ApiHeader({ name: CANDIDATE_SESSION_HEADER, description: "The candidate's session token", required: true }),
  );

export const CurrentCandidate = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CandidateRow =>
    context.switchToHttp().getRequest<CandidateRequest>().candidate as CandidateRow,
);

export const CandidateToken = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => context.switchToHttp().getRequest<CandidateRequest>().candidateToken ?? "",
);
