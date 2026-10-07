import { readFileSync } from "node:fs";
import path from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import type { DbConnection } from "../src/db/client.js";
import { createTestApp } from "./helpers/app.js";
import { connectTestDb } from "./helpers/test-db.js";

/**
 * The "Endpoint map" table in docs/API_SPLIT_PLAN.md lists a route for every admin Server Action
 * and website read. This fails when one of them is missing from the API's OpenAPI spec.
 *
 * Cell syntax: "GET/POST /posts", "POST /jobs/:id/{close,status}", "/auth/refresh" (same methods
 * as the previous item), separated by commas or semicolons. Query strings and "(notes)" are ignored.
 */
export function parseEndpointMap(markdown: string): string[] {
  const section = markdown.split(/^## Endpoint map.*$/m)[1]?.split(/^## /m)[0];
  if (!section) throw new Error("No '## Endpoint map' section found");
  const routes: string[] = [];
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4 || !cells[2].includes("/")) continue;
    let methods: string[] = [];
    for (const raw of cells[2].replace(/`/g, "").split(/[,;](?![^{]*\})/)) {
      const item = raw.replace(/\(.*?\)/g, "").trim();
      const match = /^(?:([A-Z]+(?:\/[A-Z]+)*)\s+)?(\/\S+)$/.exec(item);
      if (!match) throw new Error(`Can't read endpoint "${item}"`);
      if (match[1]) methods = match[1].split("/");
      const route = match[2].split("?")[0];
      const braces = /\{([^}]+)\}/.exec(route);
      const expanded = braces ? braces[1].split(",").map((part) => route.replace(braces[0], part.trim())) : [route];
      for (const method of methods) for (const p of expanded) routes.push(`${method} ${p}`);
    }
  }
  return routes;
}

/** "/posts/:id" and "/posts/{slug}" both become "/posts/{}". */
const normalise = (route: string) => route.replace(/:[A-Za-z]+|\{[A-Za-z]+\}/g, "{}");

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

describe("endpoint map", () => {
  it("reads the map", () => {
    expect(
      parseEndpointMap(
        "## Endpoint map\n| A | B |\n| --- | --- |\n| X | `GET/POST /a`, `/b/:id/{c,d}`; `DELETE /e?x=` |\n",
      ),
    ).toEqual(["GET /a", "POST /a", "GET /b/:id/c", "GET /b/:id/d", "POST /b/:id/c", "POST /b/:id/d", "DELETE /e"]);
  });

  it("every route in docs/API_SPLIT_PLAN.md exists", async () => {
    const expected = parseEndpointMap(readFileSync(path.join(process.cwd(), "docs/API_SPLIT_PLAN.md"), "utf8"));
    expect(expected.length).toBeGreaterThan(60);

    const spec = (await request(app.getHttpServer()).get("/docs-json").expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
    };
    const actual = new Set(
      Object.entries(spec.paths).flatMap(([p, ops]) =>
        Object.keys(ops).map((m) => `${m.toUpperCase()} ${normalise(p)}`),
      ),
    );
    const missing = expected.filter((route) => {
      const [method, p] = route.split(" ");
      return !actual.has(`${method} ${normalise(p)}`);
    });
    expect(missing).toEqual([]);
  });
});
