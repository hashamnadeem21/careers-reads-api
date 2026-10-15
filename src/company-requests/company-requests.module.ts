import { Module } from "@nestjs/common";
import { CompaniesModule } from "../companies/companies.module.js";
import { MailModule } from "../mail/mail.module.js";
import { CompanyRequestsController, CompanyRequestsPublicController } from "./company-requests.controller.js";
import { CompanyRequestsService } from "./company-requests.service.js";

@Module({
  imports: [CompaniesModule, MailModule],
  controllers: [CompanyRequestsPublicController, CompanyRequestsController],
  providers: [CompanyRequestsService],
})
export class CompanyRequestsModule {}
