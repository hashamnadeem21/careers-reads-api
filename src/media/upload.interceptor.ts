import { type CallHandler, type ExecutionContext, HttpStatus, Injectable, type NestInterceptor } from "@nestjs/common";
import multer from "multer";
import type { Observable } from "rxjs";
import { ApiError } from "../common/api-error.js";
import { MAX_FILES_PER_UPLOAD, MAX_UPLOAD_BYTES } from "./validate.js";

const parse = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES_PER_UPLOAD, fields: 5, fieldSize: 10_000 },
}).array("files", MAX_FILES_PER_UPLOAD);

function toApiError(error: unknown): unknown {
  if (!(error instanceof multer.MulterError)) return error;
  if (error.code === "LIMIT_FILE_SIZE") {
    return new ApiError(HttpStatus.PAYLOAD_TOO_LARGE, "file_too_large", "Images must be 5 MB or smaller.");
  }
  if (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE") {
    return new ApiError(
      HttpStatus.BAD_REQUEST,
      "too_many_files",
      `Upload at most ${MAX_FILES_PER_UPLOAD} images at a time, in the "files" field.`,
    );
  }
  return new ApiError(HttpStatus.BAD_REQUEST, "bad_upload", "The upload couldn't be read.");
}

/** Reads a multipart upload (field `files`, up to 20 images of 5 MB) into memory as `req.files`. */
@Injectable()
export class UploadInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    await new Promise<void>((resolve, reject) =>
      parse(http.getRequest(), http.getResponse(), (error: unknown) => (error ? reject(toApiError(error)) : resolve())),
    );
    return next.handle();
  }
}
