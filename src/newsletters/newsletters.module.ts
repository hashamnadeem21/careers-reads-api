import { Module } from "@nestjs/common";
import { MailModule } from "../mail/mail.module.js";
import { NewsletterSender } from "./newsletter-sender.service.js";
import { NewslettersController } from "./newsletters.controller.js";
import { NewslettersService } from "./newsletters.service.js";
import { SubscriptionsService } from "./subscriptions.service.js";
import { UnsubscribeController } from "./unsubscribe.controller.js";

@Module({
  imports: [MailModule],
  controllers: [NewslettersController, UnsubscribeController],
  providers: [NewslettersService, NewsletterSender, SubscriptionsService],
  exports: [NewslettersService],
})
export class NewslettersModule {}
