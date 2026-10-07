import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { ErrorFilter } from "./common/error.filter.js";
import { env } from "./config/env.js";

/** Everything main.ts does to the app, shared with the e2e tests so they test the real setup. */
export function setupApp(app: NestExpressApplication): INestApplication {
  // Behind one proxy on the host (Railway/Render/Fly), so req.ip is the visitor's address.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet());
  app.useBodyParser("json", { limit: "1mb" });
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();

  const { CORS_ORIGINS } = env();
  if (CORS_ORIGINS.length) app.enableCors({ origin: CORS_ORIGINS, credentials: false });

  const config = new DocumentBuilder()
    .setTitle("Career Reads API")
    .setDescription("Backend for the Career Reads website and admin panel.")
    .setVersion("1.0")
    .addBearerAuth()
    .build();
  SwaggerModule.setup("docs", app, () => SwaggerModule.createDocument(app, config), {
    jsonDocumentUrl: "docs-json",
  });

  return app;
}
