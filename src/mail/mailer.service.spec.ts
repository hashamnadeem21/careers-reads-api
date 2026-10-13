import { explainResendError } from "./mailer.service.js";

describe("explainResendError", () => {
  const invalidTo =
    "Invalid `to` field. Please use our testing email address instead of domains like `example.com`. See our documentation for more information.";

  it("explains the test sender's own-address-only rule", () => {
    expect(explainResendError(invalidTo, "Career Reads <onboarding@resend.dev>")).toMatch(/^Resend's test sender/);
    expect(explainResendError("You can only send testing emails to your own email address", "onboarding@resend.dev")).toMatch(
      /signed up to Resend with/,
    );
  });

  it("leaves other errors and real senders alone", () => {
    expect(explainResendError(invalidTo, "Career Reads <newsletter@careersreads.com>")).toBe(invalidTo);
    expect(explainResendError("Rate limit exceeded", "onboarding@resend.dev")).toBe("Rate limit exceeded");
  });
});
