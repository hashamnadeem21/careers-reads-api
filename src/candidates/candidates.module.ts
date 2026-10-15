import { Module } from "@nestjs/common";
import { AutomationsModule } from "../automations/automations.module.js";
import { MailModule } from "../mail/mail.module.js";
import { CandidateAuthService } from "./candidate-auth.service.js";
import { CandidateGuard } from "./candidate.guard.js";
import { CandidateSessionsService } from "./candidate-sessions.service.js";
import { CandidatesAdminController } from "./candidates-admin.controller.js";
import { CandidatesAdminService } from "./candidates-admin.service.js";
import { CandidatesPublicController } from "./candidates-public.controller.js";
import { GoogleVerifier } from "./google-verifier.service.js";

@Module({
  imports: [AutomationsModule, MailModule],
  controllers: [CandidatesPublicController, CandidatesAdminController],
  providers: [CandidateAuthService, CandidatesAdminService, CandidateSessionsService, CandidateGuard, GoogleVerifier],
  exports: [CandidateSessionsService, CandidateGuard],
})
export class CandidatesModule {}
