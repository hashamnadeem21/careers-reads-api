import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { RequestLoggerMiddleware } from "./common/request-logger.middleware.js";
import { DbModule } from "./db/db.module.js";
import { HealthController } from "./health/health.controller.js";

@Module({
  imports: [DbModule],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggerMiddleware).forRoutes("*path");
  }
}
