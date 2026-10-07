import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module.js";
import { CommonModule } from "./common/common.module.js";
import { RequestLoggerMiddleware } from "./common/request-logger.middleware.js";
import { CompaniesModule } from "./companies/companies.module.js";
import { DbModule } from "./db/db.module.js";
import { HealthController } from "./health/health.controller.js";
import { UsersModule } from "./users/users.module.js";

@Module({
  imports: [DbModule, CommonModule, AuthModule, UsersModule, CompaniesModule],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggerMiddleware).forRoutes("*path");
  }
}
