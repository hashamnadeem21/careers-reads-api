import { z } from "zod";
import { ApiError } from "./api-error.js";
import { ZodPipe } from "./zod.js";

const schema = z.object({ title: z.string().min(3), images: z.array(z.object({ alt: z.string().min(1) })) });

describe("ZodPipe", () => {
  it("returns the parsed value", () => {
    expect(new ZodPipe(schema).transform({ title: "Hello", images: [], extra: 1 })).toEqual({
      title: "Hello",
      images: [],
    });
  });

  it("throws a 400 with the first problem per field path", () => {
    try {
      new ZodPipe(schema).transform({ title: "Hi", images: [{ alt: "" }] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.getStatus()).toBe(400);
      expect(apiError.getResponse()).toEqual({
        error: {
          code: "validation_failed",
          message: "Some fields are invalid.",
          fields: { title: expect.any(String), "images.0.alt": expect.any(String) },
        },
      });
    }
  });
});
