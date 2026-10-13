import { Module } from "@nestjs/common";
import { MailModule } from "../mail/mail.module.js";
import { AutomationQueue } from "./automation-queue.service.js";
import { AutomationSender } from "./automation-sender.service.js";
import { AutomationsController } from "./automations.controller.js";
import { AutomationsService } from "./automations.service.js";

@Module({
  imports: [MailModule],
  controllers: [AutomationsController],
  providers: [AutomationsService, AutomationQueue, AutomationSender],
  exports: [AutomationQueue, AutomationSender],
})
export class AutomationsModule {}
