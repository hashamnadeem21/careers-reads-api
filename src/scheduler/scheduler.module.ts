import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { AutomationsModule } from "../automations/automations.module.js";
import { NewslettersModule } from "../newsletters/newsletters.module.js";
import { SchedulerService } from "./scheduler.service.js";

@Module({
  imports: [ScheduleModule.forRoot(), NewslettersModule, AutomationsModule],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
