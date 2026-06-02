import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

describe("Memstick desktop app", () => {
  it("boots the real Tauri window and exposes the editor", async () => {
    const editor = await $("#editor");

    await expect(editor).toBeDisplayed();
    await expect($(".md-element.rendered.heading")).toHaveText("Memstick editor POC");
  });

  it("runs the local image asset policy through Tauri IPC", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memstick-e2e-"));
    const sourcePath = path.join(tempDir, "outside-image.png");
    let copiedPath;

    try {
      fs.writeFileSync(sourcePath, onePixelPng);

      const result = await browser.executeAsync((imagePath, done) => {
        window.__TAURI__.core
          .invoke("editor_context")
          .then((context) =>
            window.__TAURI__.core.invoke("prepare_image_asset", {
              sourcePath: imagePath,
              documentPath: context.documentPath,
              projectRoot: context.projectRoot,
            }),
          )
          .then(done)
          .catch((error) => done({ error: String(error) }));
      }, sourcePath);

      expect(result.error).toBeUndefined();
      expect(result.copied).toBe(true);
      expect(result.markdownPath).toMatch(/^assets\/outside-image(?:-\d+)?\.png$/);

      copiedPath = path.join(process.cwd(), "docs", result.markdownPath);
      expect(fs.existsSync(copiedPath)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      if (copiedPath) {
        fs.rmSync(copiedPath, { force: true });
      }
    }
  });

  it("inserts a dropped local image into the editor as a relative asset path", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memstick-e2e-drop-"));
    const sourcePath = path.join(tempDir, "e2e-drop-image.png");
    const copiedPath = path.join(process.cwd(), "docs", "assets", "e2e-drop-image.png");

    try {
      fs.rmSync(copiedPath, { force: true });
      fs.writeFileSync(sourcePath, onePixelPng);
      await resetSampleAndPlaceCaretAtEnd();

      await browser.executeAsync((imagePath, done) => {
        setTimeout(() => {
          window.__TAURI__.event
            .emitTo("main", "tauri://drag-drop", {
              paths: [imagePath],
              position: { x: 0, y: 0 },
            })
            .then(() => done({ ok: true }))
            .catch((error) => done({ error: String(error) }));
        }, 50);
      }, sourcePath);

      await expect($("#source-preview")).toHaveText(expect.stringContaining("![e2e drop image](assets/e2e-drop-image.png)"));
      await browser.keys("Escape");
      await expect($('[data-url="assets/e2e-drop-image.png"]')).toBeDisplayed();
      expect(fs.existsSync(copiedPath)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(copiedPath, { force: true });
    }
  });

  it("pastes a clipboard image into assets and inserts image Markdown", async () => {
    const copiedPath = path.join(process.cwd(), "docs", "assets", "e2e-paste-image.png");

    try {
      fs.rmSync(copiedPath, { force: true });
      await resetSampleAndPlaceCaretAtEnd();

      const result = await browser.executeAsync((imageBytes, done) => {
        const editor = document.querySelector("#editor");
        const file = new File([new Uint8Array(imageBytes)], "e2e-paste-image.png", {
          type: "image/png",
        });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        const event = new Event("paste", { bubbles: true, cancelable: true });

        Object.defineProperty(event, "clipboardData", {
          value: dataTransfer,
        });

        editor.dispatchEvent(event);

        const started = Date.now();
        const interval = setInterval(() => {
          const source = document.querySelector("#source-preview")?.textContent ?? "";
          if (source.includes("![e2e paste image](assets/e2e-paste-image.png)")) {
            clearInterval(interval);
            done({ ok: true });
          }
          if (Date.now() - started > 5000) {
            clearInterval(interval);
            done({ error: source });
          }
        }, 50);
      }, [...onePixelPng]);

      expect(result.error).toBeUndefined();
      await browser.keys("Escape");
      await expect($('[data-url="assets/e2e-paste-image.png"]')).toBeDisplayed();
      expect(fs.existsSync(copiedPath)).toBe(true);
    } finally {
      fs.rmSync(copiedPath, { force: true });
    }
  });
});

async function resetSampleAndPlaceCaretAtEnd() {
  await $("#reset-sample").click();
  await $("#editor").click();
  await browser.execute(() => {
    const editor = document.querySelector("#editor");
    const runs = [...editor.querySelectorAll("[data-start][data-end]")];
    const lastRun = runs.at(-1);
    const textNode = [...lastRun.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
    const range = document.createRange();
    const selection = window.getSelection();

    editor.focus();
    range.setStart(textNode, textNode.textContent.length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  });
}
