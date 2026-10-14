import { Module } from "@nestjs/common";
import { PrivateFilesService } from "./private-files.service.js";
import { PrivateStorageService } from "./private-storage.service.js";

@Module({
  providers: [PrivateFilesService, PrivateStorageService],
  exports: [PrivateFilesService],
})
export class FilesModule {}
