import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../../src/app.module.js";
import { setupApp } from "../../src/app.setup.js";

/**
 * The real app (same setup as main.ts) on the test database. Call connectTestDb() first.
 * `override` swaps providers, e.g. a fake mailer: `(m) => m.overrideProvider(MailerService).useValue(fake)`.
 */
export async function createTestApp(
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
): Promise<NestExpressApplication> {
  const moduleRef = await override(Test.createTestingModule({ imports: [AppModule] })).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  setupApp(app);
  await app.init();
  return app;
}
