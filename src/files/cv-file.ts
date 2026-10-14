export const MAX_CV_BYTES = 5 * 1024 * 1024;

/**
 * PDF and Word (.docx) only. Old Word (.doc) is refused: it can carry macros that run on the
 * employer's computer, and every Word version since 2007 saves .docx.
 */
export const CV_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;
export type CvType = keyof typeof CV_TYPES;

export type CvCheck = { ok: true; type: CvType; contentType: string } | { ok: false; error: string };

const startsWith = (bytes: Uint8Array, signature: number[]) => signature.every((b, i) => bytes[i] === b);
const asText = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");

/**
 * Defence in depth (browsers and PDF readers sandbox these too): PDF features a CV never needs
 * but an attack does: scripts, actions that launch programs or
 * open links on their own, embedded files and rich media. Names can be written with #xx escapes
 * (/J#61vaScript), so those are decoded first.
 */
const PDF_ACTIVE = /\/(JavaScript|JS|Launch|EmbeddedFiles?|RichMedia|XFA|AA|SubmitForm|ImportData)(?![A-Za-z])/;
const PDF_ENCRYPTED = /\/Encrypt(?![A-Za-z])/;

function pdfProblem(bytes: Uint8Array): string | null {
  // Only the PDF's structure (its dictionaries) is read: compressed page and font data is
  // effectively random bytes, where a short name like /JS would turn up by chance.
  const text = asText(bytes)
    .replace(/stream\r?\n[\s\S]*?endstream/g, "")
    .replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  if (PDF_ENCRYPTED.test(text)) return "Your PDF is password-protected. Save a copy without a password and upload that.";
  if (PDF_ACTIVE.test(text)) return "This PDF contains scripts or attachments, which we don't accept. Save it again as a plain PDF (for example with “Print to PDF”).";
  return null;
}

/** A .docx is a zip whose file names are stored as plain text; macros live in vbaProject.bin (a .docm). */
function docxProblem(bytes: Uint8Array): string | null {
  const text = asText(bytes);
  if (!text.includes("word/")) return "Upload your CV as a PDF or Word document.";
  if (/vbaProject\.bin|vbaData\.xml|activeX/i.test(text)) return "Word files with macros aren't accepted. Save it as a normal .docx or a PDF.";
  return null;
}

/**
 * Checks a CV's actual bytes (never the file name or the browser's type): a PDF without active
 * content, or a Word .docx without macros, at most 5 MB.
 */
export function checkCv(bytes: Uint8Array): CvCheck {
  if (bytes.byteLength === 0) return { ok: false, error: "The file is empty." };
  if (bytes.byteLength > MAX_CV_BYTES) return { ok: false, error: "Your CV must be 5 MB or smaller." };
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    const problem = pdfProblem(bytes);
    return problem ? { ok: false, error: problem } : { ok: true, type: "pdf", contentType: CV_TYPES.pdf };
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const problem = docxProblem(bytes);
    return problem ? { ok: false, error: problem } : { ok: true, type: "docx", contentType: CV_TYPES.docx };
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { ok: false, error: "Old Word files (.doc) aren't accepted. Save your CV as .docx or PDF." };
  }
  return { ok: false, error: "Upload your CV as a PDF or Word document." };
}

/** A file name that is safe in a download header: letters, digits, spaces, dots, dashes and brackets, plus the real extension. */
export function downloadName(name: string, type: CvType): string {
  const base = (name.split(/[\\/]/).pop() ?? "")
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/[^\w .()-]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 80);
  return `${base || "cv"}.${type}`;
}
