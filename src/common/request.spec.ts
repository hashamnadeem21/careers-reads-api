import type { Request } from "express";
import { resetEnvCache } from "../config/env.js";
import { clientIp, trustedCaller } from "./request.js";

const KEY = "k".repeat(40);

function fakeRequest(headers: Record<string, string>, ip = "10.0.0.1"): Request {
  return { ip, header: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}

beforeAll(() => {
  process.env.DATABASE_URL = "postgres://localhost/x";
  process.env.JWT_SECRET = "j".repeat(40);
  process.env.SITE_API_KEY = KEY;
  resetEnvCache();
});

afterAll(() => resetEnvCache());

describe("clientIp", () => {
  it("believes X-Client-IP only from our own servers", () => {
    expect(clientIp(fakeRequest({ "x-client-ip": "203.0.113.5" }))).toBe("10.0.0.1");
    expect(clientIp(fakeRequest({ "x-client-ip": "203.0.113.5", "x-api-key": "wrong" }))).toBe("10.0.0.1");
    expect(clientIp(fakeRequest({ "x-client-ip": "203.0.113.5", "x-api-key": KEY }))).toBe("203.0.113.5");
  });

  it("identifies the caller", () => {
    expect(trustedCaller(fakeRequest({ "x-api-key": KEY }))).toBe("site");
    expect(trustedCaller(fakeRequest({}))).toBeNull();
  });
});
