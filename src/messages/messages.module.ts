import { Module } from "@nestjs/common";
import { MessagesController, SubscribersController } from "./messages.controller.js";
import { MessagesService } from "./messages.service.js";

@Module({ controllers: [MessagesController, SubscribersController], providers: [MessagesService] })
export class MessagesModule {}
