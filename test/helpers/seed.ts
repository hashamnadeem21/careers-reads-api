import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { hashPassword } from "../../src/auth/password.js";
import type { Database } from "../../src/db/client.js";
import { companies, users, type Role } from "../../src/db/schema.js";
import { TEST_ADMIN_API_KEY } from "./test-db.js";

export const PASSWORD = "correct-horse-battery-1";

let passwordHash: Promise<string> | null = null;

export async function createUser(
  db: Database,
  input: { role?: Role; companyId?: string | null; mustChangePassword?: boolean; email?: string; name?: string } = {},
) {
  passwordHash ??= hashPassword(PASSWORD);
  const [user] = await db
    .insert(users)
    .values({
      email: input.email ?? `${randomUUID()}@example.com`,
      name: input.name ?? "Test Person",
      role: input.role ?? "editor",
      companyId: input.companyId ?? null,
      mustChangePassword: input.mustChangePassword ?? false,
      passwordHash: await passwordHash,
    })
    .returning();
  return user;
}

export async function createCompany(db: Database, input: { name?: string; active?: boolean } = {}) {
  const [company] = await db
    .insert(companies)
    .values({ name: input.name ?? `Company ${randomUUID().slice(0, 8)}`, active: input.active ?? true })
    .returning();
  return company;
}

/**
 * As the admin server would call the API: with its server key and the visitor's IP. Each call
 * gets a fresh IP by default so the per-IP login limit doesn't trip across tests.
 */
export function asAdminServer(ip = `198.51.100.${Math.floor(Math.random() * 250)}-${randomUUID().slice(0, 4)}`) {
  return { "x-api-key": TEST_ADMIN_API_KEY, "x-client-ip": ip };
}

export async function login(app: NestExpressApplication, email: string, password = PASSWORD) {
  const res = await request(app.getHttpServer()).post("/auth/login").set(asAdminServer()).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { accessToken: string; refreshToken: string; user: { id: string } };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
