import type { Response } from "express";
import type { PrivateFileRow } from "../db/schema.js";

/** RFC 6266 filename, with a plain-ASCII fallback for old clients. */
export function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Headers for sending a private file. PDFs open in the browser unless `download`; Word files always download. */
export function setFileHeaders(res: Response, file: PrivateFileRow, bytes: Buffer, download = false): void {
  const inline = file.contentType === "application/pdf" && !download;
  res.set({
    "Content-Type": file.contentType,
    "Content-Length": String(bytes.byteLength),
    "Content-Disposition": disposition(inline ? "inline" : "attachment", file.originalName),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
}
