import { imageSize } from "image-size";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 20;
export const ALLOWED_TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif" } as const;
export type ImageType = keyof typeof ALLOWED_TYPES;

export type ImageCheck =
  { ok: true; type: ImageType; width: number; height: number; contentType: string } | { ok: false; error: string };

/** AVIF is an ISO-BMFF file whose `ftyp` brand is avif/avis. */
function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const box = new TextDecoder().decode(bytes.subarray(4, 12));
  return box === "ftypavif" || box === "ftypavis";
}

/**
 * Checks the actual bytes (never the file name or the browser's MIME type):
 * only JPG, PNG, WebP and AVIF, at most 5 MB, with readable dimensions.
 */
export function checkImage(bytes: Uint8Array): ImageCheck {
  if (bytes.byteLength === 0) return { ok: false, error: "The file is empty." };
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, error: "Images must be 5 MB or smaller." };
  let info: ReturnType<typeof imageSize>;
  try {
    info = imageSize(bytes);
  } catch {
    return { ok: false, error: "Only JPG, PNG, WebP and AVIF images are allowed." };
  }
  const type: ImageType | null =
    info.type === "jpg" || info.type === "png" || info.type === "webp" ? info.type : isAvif(bytes) ? "avif" : null;
  if (!type) return { ok: false, error: "Only JPG, PNG, WebP and AVIF images are allowed." };
  const rotated = (info.orientation ?? 1) >= 5;
  const width = rotated ? info.height : info.width;
  const height = rotated ? info.width : info.height;
  if (!width || !height) return { ok: false, error: "Couldn't read the image size." };
  if (width > 12000 || height > 12000) return { ok: false, error: "Images must be under 12,000 pixels on each side." };
  return { ok: true, type, width, height, contentType: ALLOWED_TYPES[type] };
}

/** "My Photo (1).JPG" → "my-photo-1", used as a readable prefix before the random part. */
export function safeBaseName(fileName: string): string {
  return (
    fileName
      .replace(/\.[^.]+$/, "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "image"
  );
}
