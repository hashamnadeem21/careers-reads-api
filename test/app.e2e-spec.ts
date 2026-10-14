import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { DbConnection } from "../src/db/client.js";
import { resetEnvCache } from "../src/config/env.js";
import { createTestApp } from "./helpers/app.js";
import { connectTestDb } from "./helpers/test-db.js";

let connection: DbConnection;
let app: NestExpressApplication;

beforeAll(async () => {
  connection = await connectTestDb();
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await connection.end();
});

describe("app", () => {
  it("GET /health reports the database is reachable", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body).toEqual({ status: "ok", database: "ok" });
  });

  it("serves the OpenAPI spec", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    expect(res.body.info.title).toBe("Career Reads API");
    expect(Object.keys(res.body.paths)).toContain("/health");
  });

  it("can switch the API reference off (production default)", async () => {
    process.env.API_DOCS = "false";
    resetEnvCache();
    const hidden = await createTestApp();
    try {
      await request(hidden.getHttpServer()).get("/docs-json").expect(404);
      await request(hidden.getHttpServer()).get("/docs").expect(404);
    } finally {
      await hidden.close();
      delete process.env.API_DOCS;
      resetEnvCache();
    }
  });

  it("returns the standard error shape for unknown routes", async () => {
    const res = await request(app.getHttpServer()).get("/nope").expect(404);
    expect(res.body).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("sets security headers and hides the framework", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
