import { Module } from "@nestjs/common";
import { FilesModule } from "../files/files.module.js";
import { MailModule } from "../mail/mail.module.js";
import { ApplicationNotifier } from "./application-notifier.service.js";
import { ApplicationsPublicController } from "./applications-public.controller.js";
import { ApplicationsController } from "./applications.controller.js";
import { ApplicationsService } from "./applications.service.js";
import { ApplyService } from "./apply.service.js";

@Module({
  imports: [FilesModule, MailModule],
  controllers: [ApplicationsPublicController, ApplicationsController],
  providers: [ApplyService, ApplicationsService, ApplicationNotifier],
  exports: [ApplicationNotifier, FilesModule],
})
export class ApplicationsModule {}
