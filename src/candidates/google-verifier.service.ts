import { Injectable, Logger } from "@nestjs/common";
import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env.js";

/** What we keep from a verified Google sign-in. */
export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
}

/**
 * Verifies the ID token the "Sign in with Google" button gives the browser: Google's signature,
 * our client ID as the audience, Google as the issuer, not expired, and a verified email.
 * The only class that talks to Google: tests replace it with a fake.
 */
@Injectable()
export class GoogleVerifier {
  private readonly logger = new Logger("GoogleSignIn");
  private client: OAuth2Client | null = null;

  enabled(): boolean {
    return Boolean(env().GOOGLE_CLIENT_ID);
  }

  async verify(credential: string): Promise<GoogleProfile | null> {
    const clientId = env().GOOGLE_CLIENT_ID;
    if (!clientId) return null;
    this.client ??= new OAuth2Client(clientId);
    try {
      const ticket = await this.client.verifyIdToken({ idToken: credential, audience: clientId });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email || payload.email_verified !== true) return null;
      if (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") return null;
      return {
        sub: payload.sub,
        email: payload.email.toLowerCase(),
        name: (payload.name ?? "").trim() || payload.email.split("@")[0],
        picture: payload.picture ?? null,
      };
    } catch (error) {
      this.logger.debug(`Rejected a Google token: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
