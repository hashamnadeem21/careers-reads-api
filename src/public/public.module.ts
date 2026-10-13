import { Module } from "@nestjs/common";
import { AutomationsModule } from "../automations/automations.module.js";
import { PublicController } from "./public.controller.js";
import { PublicService } from "./public.service.js";

@Module({
  imports: [AutomationsModule],
  controllers: [PublicController],
  providers: [PublicService],
})
export class PublicModule {}
