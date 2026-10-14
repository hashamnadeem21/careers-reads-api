import { type CallHandler, type ExecutionContext, HttpStatus, Injectable, type NestInterceptor } from "@nestjs/common";
import multer from "multer";
import type { Observable } from "rxjs";
import { ApiError } from "../common/api-error.js";
import { MAX_CV_BYTES } from "../files/cv-file.js";

const parse = multer({
  storage: multer.memoryStorage(),
  // Answers to up to 15 questions arrive as one JSON field, so fields may be fairly long.
  limits: { fileSize: MAX_CV_BYTES, files: 1, fields: 15, fieldSize: 64_000 },
}).single("cv");

function toApiError(error: unknown): unknown {
  if (!(error instanceof multer.MulterError)) return error;
  if (error.code === "LIMIT_FILE_SIZE") {
    return new ApiError(HttpStatus.PAYLOAD_TOO_LARGE, "file_too_large", "Your CV must be 5 MB or smaller.", {
      cv: "Your CV must be 5 MB or smaller.",
    });
  }
  return new ApiError(HttpStatus.BAD_REQUEST, "bad_upload", "The application couldn't be read. Please try again.");
}

/** Reads an application (multipart: the fields plus one file, `cv`, up to 5 MB) into memory as `req.file`. */
@Injectable()
export class CvUploadInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    await new Promise<void>((resolve, reject) =>
      parse(http.getRequest(), http.getResponse(), (error: unknown) => (error ? reject(toApiError(error)) : resolve())),
    );
    return next.handle();
  }
}
