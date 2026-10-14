import { checkCv, downloadName, MAX_CV_BYTES } from "./cv-file.js";

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p, "latin1")] : p)));

const PDF = "%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n";
const ZIP = [0x50, 0x4b, 0x03, 0x04];

describe("checkCv", () => {
  it("accepts PDF and Word files by their bytes", () => {
    expect(checkCv(bytes(PDF))).toMatchObject({ ok: true, type: "pdf", contentType: "application/pdf" });
    expect(checkCv(bytes(ZIP, "....word/document.xml"))).toMatchObject({ ok: true, type: "docx" });
  });

  it("refuses anything else, whatever its name", () => {
    expect(checkCv(bytes(ZIP, "xl/workbook.xml"))).toEqual({ ok: false, error: "Upload your CV as a PDF or Word document." });
    expect(checkCv(bytes("<html><script>"))).toMatchObject({ ok: false });
    expect(checkCv(new Uint8Array())).toEqual({ ok: false, error: "The file is empty." });
    const big = new Uint8Array(MAX_CV_BYTES + 1);
    big.set(Buffer.from("%PDF-"));
    expect(checkCv(big)).toEqual({ ok: false, error: "Your CV must be 5 MB or smaller." });
  });

  it("refuses files that can run code on the employer's computer", () => {
    expect(checkCv(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], "...."))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/\.doc\) aren't accepted/),
    });
    expect(checkCv(bytes(ZIP, "word/document.xml word/vbaProject.bin"))).toMatchObject({ ok: false, error: expect.stringMatching(/macros/) });
    for (const active of ["/OpenAction << /S /JavaScript /JS (app.alert(1)) >>", "/S /Launch /F (cmd.exe)", "/EmbeddedFiles 3 0 R", "/J#61vaScript"]) {
      expect(checkCv(bytes(PDF, `2 0 obj << ${active} >> endobj`)), active).toMatchObject({ ok: false, error: expect.stringMatching(/scripts or attachments/) });
    }
    expect(checkCv(bytes(PDF, "trailer << /Encrypt 5 0 R >>"))).toMatchObject({ ok: false, error: expect.stringMatching(/password/) });
  });

  it("doesn't mistake compressed page data for scripts", () => {
    expect(checkCv(bytes(PDF, "3 0 obj << /Length 9 /Filter /FlateDecode >> stream\nx\u009c/JS /AA\nendstream endobj"))).toMatchObject({ ok: true });
  });
});

describe("downloadName", () => {
  it("keeps a readable name with the file's real extension", () => {
    expect(downloadName("Sara Khan – CV (final).PDF", "pdf")).toBe("Sara Khan CV (final).pdf");
    expect(downloadName("resume.exe", "docx")).toBe("resume.docx");
  });

  it("drops folders and anything that could break a header", () => {
    expect(downloadName("../../etc/passwd", "pdf")).toBe("passwd.pdf");
    expect(downloadName('C:\\Users\\me\\cv".pdf', "pdf")).toBe("cv.pdf");
    expect(downloadName("....", "docx")).toBe("cv.docx");
  });
});
