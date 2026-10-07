import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetEnvCache } from "../config/env.js";
import { MediaStorageService } from "./media-storage.service.js";

describe("MediaStorageService (self-hosted uploads)", () => {
  let dir: string;
  const storage = new MediaStorageService();
  const bytes = new Uint8Array([1, 2, 3]);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "api-storage-"));
    Object.assign(process.env, {
      DATABASE_URL: "postgres://localhost/unused",
      JWT_SECRET: "x".repeat(32),
      UPLOADS_DIR: dir,
      UPLOADS_PUBLIC_URL: "https://api.example.com/uploads/",
    });
    delete process.env.BLOB_READ_WRITE_TOKEN;
    resetEnvCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.UPLOADS_PUBLIC_URL;
    delete process.env.UPLOADS_DIR;
    resetEnvCache();
  });

  it("stores the file in UPLOADS_DIR and returns an absolute URL under UPLOADS_PUBLIC_URL", async () => {
    const url = await storage.store(bytes, "My Hero.png", "png", "image/png");
    expect(url).toMatch(/^https:\/\/api\.example\.com\/uploads\/my-hero-[0-9a-f]{16}\.png$/);
    expect(existsSync(path.join(dir, path.basename(url)))).toBe(true);

    await storage.remove(url);
    expect(existsSync(path.join(dir, path.basename(url)))).toBe(false);
  });

  it("still removes files stored before UPLOADS_PUBLIC_URL was set, and ignores other hosts", async () => {
    delete process.env.UPLOADS_PUBLIC_URL;
    resetEnvCache();
    const relative = await storage.store(bytes, "old.png", "png", "image/png");
    expect(relative).toMatch(/^\/uploads\//);

    process.env.UPLOADS_PUBLIC_URL = "https://api.example.com/uploads";
    resetEnvCache();
    await storage.remove(`https://elsewhere.example.com/uploads/${path.basename(relative)}`);
    expect(existsSync(path.join(dir, path.basename(relative)))).toBe(true);
    await storage.remove(relative);
    expect(existsSync(path.join(dir, path.basename(relative)))).toBe(false);
  });
});
