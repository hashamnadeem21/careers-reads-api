import { Module } from "@nestjs/common";
import { ActivityController, DashboardController } from "./dashboard.controller.js";

@Module({ controllers: [DashboardController, ActivityController] })
export class DashboardModule {}
