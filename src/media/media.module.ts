import { Module } from "@nestjs/common";
import { MediaController } from "./media.controller.js";
import { MediaService } from "./media.service.js";
import { MediaStorageService } from "./media-storage.service.js";

@Module({
  controllers: [MediaController],
  providers: [MediaService, MediaStorageService],
})
export class MediaModule {}
