import { config } from "dotenv";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { setupApp } from "./app.setup.js";
import { env } from "./config/env.js";

config({ path: [".env.local", ".env"], quiet: true });

const app = await NestFactory.create<NestExpressApplication>(AppModule);
setupApp(app);
await app.listen(env().PORT);
