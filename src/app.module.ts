import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module.js";
import { CommonModule } from "./common/common.module.js";
import { RequestLoggerMiddleware } from "./common/request-logger.middleware.js";
import { CompaniesModule } from "./companies/companies.module.js";
import { DbModule } from "./db/db.module.js";
import { PublicModule } from "./public/public.module.js";
import { JobsModule } from "./jobs/jobs.module.js";
import { MediaModule } from "./media/media.module.js";
import { PostsModule } from "./posts/posts.module.js";
import { AuthorsModule } from "./authors/authors.module.js";
import { CategoriesModule } from "./categories/categories.module.js";
import { DashboardModule } from "./dashboard/dashboard.module.js";
import { MessagesModule } from "./messages/messages.module.js";
import { PreferencesModule } from "./preferences/preferences.module.js";
import { SearchModule } from "./search/search.module.js";
import { SettingsModule } from "./settings/settings.module.js";
import { HealthController } from "./health/health.controller.js";
import { UsersModule } from "./users/users.module.js";

@Module({
  imports: [
    DbModule,
    CommonModule,
    AuthModule,
    UsersModule,
    CompaniesModule,
    PostsModule,
    JobsModule,
    MediaModule,
    CategoriesModule,
    AuthorsModule,
    MessagesModule,
    SettingsModule,
    DashboardModule,
    SearchModule,
    PreferencesModule,
    PublicModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggerMiddleware).forRoutes("*path");
  }
}
