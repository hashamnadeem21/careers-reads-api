import { checkImage, MAX_UPLOAD_BYTES, safeBaseName } from "./validate.js";

const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');

describe("checkImage", () => {
  it("accepts real PNG bytes and reads the size", () => {
    expect(checkImage(PNG)).toEqual({ ok: true, type: "png", width: 1, height: 1, contentType: "image/png" });
  });

  it("rejects other formats regardless of file name (SVG can carry scripts)", () => {
    expect(checkImage(SVG)).toMatchObject({ ok: false });
    expect(checkImage(new TextEncoder().encode("<script>alert(1)</script>"))).toMatchObject({ ok: false });
  });

  it("rejects files over 5 MB and empty files", () => {
    expect(checkImage(new Uint8Array(MAX_UPLOAD_BYTES + 1))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/5 MB/),
    });
    expect(checkImage(new Uint8Array())).toMatchObject({ ok: false });
  });

  it("makes safe readable base names", () => {
    expect(safeBaseName("../../My Photo (1).JPG")).toBe("my-photo-1");
    expect(safeBaseName(".png")).toBe("image");
  });
});
