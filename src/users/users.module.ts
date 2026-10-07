import { Module } from "@nestjs/common";
import { InvitesService } from "./invites.service.js";
import { InvitesController, UsersController } from "./users.controller.js";
import { UsersService } from "./users.service.js";

@Module({
  controllers: [UsersController, InvitesController],
  providers: [UsersService, InvitesService],
  exports: [InvitesService],
})
export class UsersModule {}
