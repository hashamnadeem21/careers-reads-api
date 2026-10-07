import { Global, Module } from "@nestjs/common";
import { AuditService } from "./audit.service.js";
import { RateLimitService } from "./rate-limit.service.js";
import { RevalidateSiteService } from "./revalidate-site.service.js";

@Global()
@Module({
  providers: [AuditService, RateLimitService, RevalidateSiteService],
  exports: [AuditService, RateLimitService, RevalidateSiteService],
})
export class CommonModule {}
