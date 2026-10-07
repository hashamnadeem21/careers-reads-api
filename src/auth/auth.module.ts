import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { env } from "../config/env.js";
import { AuthController } from "./auth.controller.js";
import { AuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { SessionsService } from "./sessions.service.js";

@Global()
@Module({
  imports: [JwtModule.registerAsync({ useFactory: () => ({ secret: env().JWT_SECRET }) })],
  controllers: [AuthController],
  providers: [AuthService, SessionsService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthService, SessionsService],
})
export class AuthModule {}
