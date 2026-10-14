import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { ErrorFilter } from "./common/error.filter.js";
import { env, isProduction } from "./config/env.js";

/** Everything main.ts does to the app, shared with the e2e tests so they test the real setup. */
export function setupApp(app: NestExpressApplication): INestApplication {
  const { CORS_ORIGINS, TRUST_PROXY, API_DOCS } = env();
  // Behind the host's proxy (Railway/Render/Fly: one hop), so req.ip is the caller's address.
  app.set("trust proxy", TRUST_PROXY);
  app.disable("x-powered-by");
  app.use(helmet());
  app.useBodyParser("json", { limit: "1mb" });
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();

  // Off unless CORS_ORIGINS is set: the admin and website call the API from their servers.
  if (CORS_ORIGINS.length) app.enableCors({ origin: CORS_ORIGINS, credentials: false });

  // The API reference: always in development and tests, in production only when API_DOCS=true.
  if ((API_DOCS ?? (isProduction ? "false" : "true")) !== "true") return app;
  const config = new DocumentBuilder()
    .setTitle("Career Reads API")
    .setDescription("Backend for the Career Reads website and admin panel.")
    .setVersion("1.0")
    .addBearerAuth()
    .addApiKey({ type: "apiKey", in: "header", name: "x-api-key" }, "api-key")
    .build();
  SwaggerModule.setup("docs", app, () => SwaggerModule.createDocument(app, config), {
    jsonDocumentUrl: "docs-json",
  });

  return app;
}
