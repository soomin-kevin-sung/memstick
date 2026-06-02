import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DragDropEvent } from "@tauri-apps/api/window";

type ElementType =
  | "heading"
  | "blockquote"
  | "rule"
  | "codeblock"
  | "table"
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "image"
  | "link";

type MarkdownElement = {
  id: string;
  type: ElementType;
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
  text: string;
  level?: number;
  language?: string;
  urlStart?: number;
  urlEnd?: number;
  url?: string;
};

type SourceSelection = {
  start: number;
  end: number;
  collapsed: boolean;
};

type CodeToken = {
  text: string;
  className?: string;
};

type EditorContext = {
  documentPath: string | null;
  projectRoot: string | null;
};

type PreparedImageAsset = {
  markdownPath: string;
  copied: boolean;
};

type ResolvedImageSource = {
  src: string;
};

const sampleMarkdown = [
  "# Memstick editor POC",
  "",
  "This surface keeps **Markdown source** and rendered text in the same place.",
  "Try `inline code`, *italic text*, ~~struck text~~, [a link](https://tauri.app), and ![inline badge](https://img.shields.io/badge/image-inline-8a3f29).",
  "Broken image fallback: ![missing image](https://example.invalid/missing-image.png)",
  "A standalone image still follows inline Markdown semantics:",
  "![Memstick sample](https://placehold.co/480x220/png?text=Memstick+Image)",
  "",
  "> Blockquotes should open just like headings.",
  "",
  "| Name | Role | Status |",
  "| --- | --- | --- |",
  "| Sumin | Developer | Writing |",
  "| Codex | Agent | Reviewing |",
  "",
  "---",
  "",
  "```ts",
  "const message = \"Code fences stay plain.\";",
  "```",
  "",
  "Backspace after a rendered element opens it first. Selecting across a boundary removes the Markdown wrapper.",
].join("\n");

let markdown = sampleMarkdown;
let elements: MarkdownElement[] = [];
let activeElementIds = new Set<string>();
let editorEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let sourceEl: HTMLElement | null = null;
let isRendering = false;
let isComposing = false;
let compositionRange: SourceSelection | null = null;
let pendingCompositionText = "";
let pendingSelectionSync = 0;
let editorContext: EditorContext = { documentPath: null, projectRoot: null };
const imageSourceCache = new Map<string, string>();

const app = document.querySelector<HTMLDivElement>("#app");

if (app) {
  app.innerHTML = `
    <main class="workspace">
      <section class="topbar" aria-label="Editor controls">
        <div>
          <p class="eyebrow">Memstick POC 1</p>
          <h1>Same-surface Markdown editor</h1>
        </div>
        <div class="actions">
          <button id="reset-sample" type="button">Reset</button>
          <button id="copy-markdown" type="button">Copy Markdown</button>
        </div>
      </section>

      <section class="editor-shell" aria-label="Markdown editor prototype">
        <div class="editor-ruler">
          <span>Rendered</span>
          <span>Editing opens on intent</span>
        </div>
        <div
          id="editor"
          class="editor"
          contenteditable="true"
          spellcheck="false"
          role="textbox"
          aria-multiline="true"
          aria-label="Typora-like Markdown editor"
        ></div>
        <div id="editor-status" class="editor-status" aria-live="polite"></div>
      </section>

      <aside class="source-panel" aria-label="Markdown source mirror">
        <div class="panel-label">Markdown source</div>
        <pre id="source-preview"></pre>
      </aside>
    </main>
  `;

  editorEl = document.querySelector("#editor");
  statusEl = document.querySelector("#editor-status");
  sourceEl = document.querySelector("#source-preview");

  document.querySelector("#reset-sample")?.addEventListener("click", () => {
    markdown = sampleMarkdown;
    activeElementIds.clear();
    render(0);
  });

  document.querySelector("#copy-markdown")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(markdown);
    updateStatus("Markdown copied");
  });

  editorEl?.addEventListener("keydown", handleKeydown);
  editorEl?.addEventListener("beforeinput", handleBeforeInput);
  editorEl?.addEventListener("pointerdown", handlePointerDown);
  editorEl?.addEventListener("paste", handlePaste);
  editorEl?.addEventListener("dragover", handleDragOver);
  editorEl?.addEventListener("drop", handleBrowserDrop);
  editorEl?.addEventListener("compositionstart", () => {
    isComposing = true;
    compositionRange = readSelection();
    pendingCompositionText = "";
  });
  editorEl?.addEventListener("compositionend", (event) => {
    isComposing = false;
    commitComposition(event);
  });
  editorEl?.addEventListener("mouseup", handleMouseup);
  editorEl?.addEventListener("focus", queueSelectionSync);
  document.addEventListener("selectionchange", queueSelectionSync);

  render(0);
  void initializeLocalImageHandling();
}

async function initializeLocalImageHandling(): Promise<void> {
  if (!isTauri()) {
    return;
  }

  try {
    editorContext = await invoke<EditorContext>("editor_context");
    await getCurrentWindow().onDragDropEvent((event) => {
      void handleTauriDragDrop(event.payload);
    });
  } catch (error) {
    updateStatus(`Image assets unavailable: ${String(error)}`);
  }
}

function parseMarkdown(source: string): MarkdownElement[] {
  const parsed: MarkdownElement[] = [];
  const lines = getSourceLines(source);

  for (let index = 0; index < lines.length; index += 1) {
    const { text: line, start: lineStart, end: lineEnd } = lines[index];

    if (line.startsWith("```")) {
      let closingIndex = -1;
      for (let next = index + 1; next < lines.length; next += 1) {
        if (lines[next].text.startsWith("```")) {
          closingIndex = next;
          break;
        }
      }

      if (closingIndex > index) {
        const closingLine = lines[closingIndex];
        const contentStart = lineEnd + 1;
        const contentEnd = closingLine.start > contentStart ? closingLine.start - 1 : contentStart;
        parsed.push({
          id: `codeblock:${lineStart}:${closingLine.end}`,
          type: "codeblock",
          start: lineStart,
          end: closingLine.end,
          contentStart,
          contentEnd,
          text: source.slice(contentStart, contentEnd),
          language: line.slice(3).trim(),
        });
        index = closingIndex;
        continue;
      }
    }

    if (isTableHeaderLine(line) && lines[index + 1] && isTableDelimiterLine(lines[index + 1].text)) {
      let tableEndIndex = index + 1;
      for (let next = index + 2; next < lines.length; next += 1) {
        if (!isTableRowLine(lines[next].text)) {
          break;
        }
        tableEndIndex = next;
      }

      const tableEnd = lines[tableEndIndex].end;
      parsed.push({
        id: `table:${lineStart}:${tableEnd}`,
        type: "table",
        start: lineStart,
        end: tableEnd,
        contentStart: lineStart,
        contentEnd: tableEnd,
        text: source.slice(lineStart, tableEnd),
      });
      index = tableEndIndex;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const blockquote = /^>\s?(.+)$/.exec(line);
    const rule = /^(?:-{3,}|\*{3,}|_{3,})\s*$/.exec(line);

    if (heading) {
      const marker = heading[1];
      const contentStart = lineStart + marker.length + 1;
      parsed.push({
        id: `heading:${lineStart}:${lineEnd}`,
        type: "heading",
        start: lineStart,
        end: lineEnd,
        contentStart,
        contentEnd: lineEnd,
        text: source.slice(contentStart, lineEnd),
        level: marker.length,
      });
    } else if (blockquote) {
      const markerLength = line.startsWith("> ") ? 2 : 1;
      const contentStart = lineStart + markerLength;
      parsed.push({
        id: `blockquote:${lineStart}:${lineEnd}`,
        type: "blockquote",
        start: lineStart,
        end: lineEnd,
        contentStart,
        contentEnd: lineEnd,
        text: source.slice(contentStart, lineEnd),
      });
    } else if (rule) {
      parsed.push({
        id: `rule:${lineStart}:${lineEnd}`,
        type: "rule",
        start: lineStart,
        end: lineEnd,
        contentStart: lineStart,
        contentEnd: lineEnd,
        text: "",
      });
    } else {
      parsed.push(...parseInlineMarkdown(source, lineStart, lineEnd));
    }
  }

  return parsed.sort((a, b) => a.start - b.start);
}

function getSourceLines(source: string): Array<{ text: string; start: number; end: number }> {
  const lines = source.split("\n");
  let offset = 0;

  return lines.map((text) => {
    const start = offset;
    const end = start + text.length;
    offset = end + 1;
    return { text, start, end };
  });
}

function getSourceLineAt(index: number): { text: string; start: number; end: number } {
  const lineStart = markdown.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const nextBreak = markdown.indexOf("\n", index);
  const lineEnd = nextBreak === -1 ? markdown.length : nextBreak;

  return {
    text: markdown.slice(lineStart, lineEnd),
    start: lineStart,
    end: lineEnd,
  };
}

function isHorizontalRuleSource(text: string): boolean {
  return /^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(text);
}

function isTableHeaderLine(text: string): boolean {
  return isTableRowLine(text) && splitTableRow(text).length >= 2;
}

function isTableDelimiterLine(text: string): boolean {
  if (!isTableRowLine(text)) {
    return false;
  }

  return splitTableRow(text).every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function isTableRowLine(text: string): boolean {
  return /^\s*\|.*\|\s*$/.test(text);
}

function splitTableRow(text: string): string[] {
  return text
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseInlineMarkdown(
  source: string,
  lineStart: number,
  lineEnd: number,
): MarkdownElement[] {
  const parsed: MarkdownElement[] = [];
  let cursor = lineStart;

  while (cursor < lineEnd) {
    const rest = source.slice(cursor, lineEnd);
    const candidates = [
      matchImage(source, cursor, lineEnd),
      matchLink(source, cursor, lineEnd),
      matchWrapped(source, cursor, lineEnd, "~~", "strike"),
      matchWrapped(source, cursor, lineEnd, "**", "bold"),
      matchWrapped(source, cursor, lineEnd, "`", "code"),
      matchWrapped(source, cursor, lineEnd, "*", "italic"),
    ].filter(Boolean) as MarkdownElement[];

    candidates.sort((a, b) => a.start - b.start || a.end - b.end);
    const next = candidates[0];

    if (!next) {
      break;
    }

    if (next.start < cursor || next.end > lineEnd || next.text.length === 0) {
      cursor += Math.max(rest.indexOf("\n"), 1);
      continue;
    }

    parsed.push(next);
    cursor = next.end;
  }

  return parsed;
}

function matchImage(source: string, from: number, limit: number): MarkdownElement | null {
  const marker = source.indexOf("![", from);
  if (marker < 0 || marker >= limit) {
    return null;
  }

  const close = source.indexOf("](", marker + 2);
  if (close < 0 || close >= limit) {
    return null;
  }

  const urlEnd = source.indexOf(")", close + 2);
  if (urlEnd < 0 || urlEnd >= limit) {
    return null;
  }

  return {
    id: `image:${marker}:${urlEnd + 1}`,
    type: "image",
    start: marker,
    end: urlEnd + 1,
    contentStart: marker + 2,
    contentEnd: close,
    text: source.slice(marker + 2, close),
    urlStart: close + 2,
    urlEnd,
    url: source.slice(close + 2, urlEnd),
  };
}

function matchWrapped(
  source: string,
  from: number,
  limit: number,
  token: "*" | "**" | "~~" | "`",
  type: "bold" | "italic" | "strike" | "code",
): MarkdownElement | null {
  const start = source.indexOf(token, from);
  if (start < 0 || start >= limit) {
    return null;
  }

  if (type === "italic" && source[start + 1] === "*") {
    return matchWrapped(source, start + 2, limit, token, type);
  }

  const contentStart = start + token.length;
  const endToken = source.indexOf(token, contentStart);
  if (endToken < 0 || endToken >= limit || endToken === contentStart) {
    return null;
  }

  if (type === "italic" && source[endToken + 1] === "*") {
    return matchWrapped(source, endToken + 2, limit, token, type);
  }

  const end = endToken + token.length;
  return {
    id: `${type}:${start}:${end}`,
    type,
    start,
    end,
    contentStart,
    contentEnd: endToken,
    text: source.slice(contentStart, endToken),
  };
}

function matchLink(source: string, from: number, limit: number): MarkdownElement | null {
  const open = source.indexOf("[", from);
  if (open < 0 || open >= limit) {
    return null;
  }

  const close = source.indexOf("](", open + 1);
  if (close < 0 || close >= limit) {
    return null;
  }

  const urlEnd = source.indexOf(")", close + 2);
  if (urlEnd < 0 || urlEnd >= limit || close === open + 1) {
    return null;
  }

  return {
    id: `link:${open}:${urlEnd + 1}`,
    type: "link",
    start: open,
    end: urlEnd + 1,
    contentStart: open + 1,
    contentEnd: close,
    text: source.slice(open + 1, close),
    urlStart: close + 2,
    urlEnd,
    url: source.slice(close + 2, urlEnd),
  };
}

function render(selectionStart?: number, selectionEnd = selectionStart): void {
  if (!editorEl) {
    return;
  }

  isRendering = true;
  elements = parseMarkdown(markdown);
  const validElementIds = new Set(elements.map((element) => element.id));
  activeElementIds = new Set(
    [...activeElementIds].filter((id) => validElementIds.has(id)),
  );

  editorEl.innerHTML = renderLines();
  bindImageFallbacks();
  if (sourceEl) {
    sourceEl.textContent = markdown;
  }

  if (typeof selectionStart === "number") {
    setSelectionBySourceRange(selectionStart, selectionEnd ?? selectionStart);
  }

  updateStatus();
  isRendering = false;
}

function renderLines(): string {
  const lines = getSourceLines(markdown);
  const html: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const { start, end } = lines[index];
    const block = findLineBlockAt(start);

    if (block?.type === "codeblock" || block?.type === "table") {
      html.push(
        `<div class="editor-line ${block.type}-line" data-line-start="${start}" data-line-end="${block.end}">${
          activeElementIds.has(block.id) ? renderEditingElement(block) : renderRenderedElement(block)
        }</div>`,
      );
      while (index + 1 < lines.length && lines[index + 1].end <= block.end) {
        index += 1;
      }
      continue;
    }

    html.push(
      `<div class="editor-line" data-line-start="${start}" data-line-end="${end}">${renderLine(start, end)}</div>`,
    );
  }

  return html.join("");
}

function bindImageFallbacks(): void {
  if (!editorEl) {
    return;
  }

  editorEl.querySelectorAll<HTMLImageElement>(".image-preview img").forEach((image) => {
    const wrapper = image.closest<HTMLElement>(".image-preview");
    if (!wrapper) {
      return;
    }

    const markdownPath = wrapper.dataset.url;
    if (markdownPath && isTauri()) {
      void resolveLocalImageSource(markdownPath).then((src) => {
        if (src) {
          image.src = src;
        }
      });
    }

    image.addEventListener("load", () => {
      wrapper.classList.remove("image-broken");
    });
    image.addEventListener("error", () => {
      wrapper.classList.add("image-broken");
    });

    if (image.complete && image.naturalWidth === 0) {
      wrapper.classList.add("image-broken");
    }
  });
}

async function resolveLocalImageSource(markdownPath: string): Promise<string | null> {
  if (
    !markdownPath ||
    markdownPath.startsWith("http://") ||
    markdownPath.startsWith("https://") ||
    markdownPath.startsWith("data:")
  ) {
    return null;
  }

  const cacheKey = `${editorContext.documentPath ?? ""}:${markdownPath}`;
  const cached = imageSourceCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const resolved = await invoke<ResolvedImageSource | null>("resolve_markdown_image_src", {
      markdownPath,
      documentPath: editorContext.documentPath,
    });
    if (!resolved?.src) {
      return null;
    }
    imageSourceCache.set(cacheKey, resolved.src);
    return resolved.src;
  } catch {
    return null;
  }
}

function renderLine(start: number, end: number): string {
  if (start === end) {
    return `<span class="source-run empty-run" data-start="${start}" data-end="${start}">\u200b</span>`;
  }

  const heading = elements.find(
    (element) => element.type === "heading" && element.start === start && element.end === end,
  );

  if (heading) {
    return activeElementIds.has(heading.id)
      ? renderEditingElement(heading)
      : renderRenderedElement(heading);
  }

  const block = findLineBlockAt(start);

  if (block) {
    return activeElementIds.has(block.id)
      ? renderEditingElement(block)
      : renderRenderedElement(block);
  }

  const inlineElements = elements.filter(
    (element) =>
      isInlineElement(element) && element.start >= start && element.end <= end,
  );

  let cursor = start;
  let html = "";

  for (const element of inlineElements) {
    if (element.start < cursor) {
      continue;
    }

    html += renderSourceRun(markdown.slice(cursor, element.start), cursor);
    html += activeElementIds.has(element.id)
      ? renderEditingElement(element)
      : renderRenderedElement(element);
    cursor = element.end;
  }

  html += renderSourceRun(markdown.slice(cursor, end), cursor);
  return html;
}

function renderRenderedElement(element: MarkdownElement): string {
  const common = [
    `data-element-id="${escapeHtml(element.id)}"`,
    `data-element-type="${element.type}"`,
    `data-start="${element.contentStart}"`,
    `data-end="${element.contentEnd}"`,
    `data-full-start="${element.start}"`,
    `data-full-end="${element.end}"`,
    element.urlEnd === undefined ? "" : `data-url-end="${element.urlEnd}"`,
    `data-rendered="true"`,
  ].join(" ");

  const text = escapeHtml(element.text);

  if (element.type === "heading") {
    return `<span class="md-element rendered heading heading-${element.level}" ${common}>${text}</span>`;
  }

  if (element.type === "blockquote") {
    return `<blockquote class="md-element rendered blockquote" ${common}>${text}</blockquote>`;
  }

  if (element.type === "rule") {
    return `<span class="md-element rendered rule" ${common} aria-label="Horizontal rule"></span>`;
  }

  if (element.type === "codeblock") {
    return `<pre class="md-element rendered codeblock" ${common}><code>${highlightCode(
      element.text,
      element.language,
    )}</code></pre>`;
  }

  if (element.type === "table") {
    return renderTableElement(element, common);
  }

  if (element.type === "bold") {
    return `<strong class="md-element rendered inline bold" ${common}>${text}</strong>`;
  }

  if (element.type === "italic") {
    return `<em class="md-element rendered inline italic" ${common}>${text}</em>`;
  }

  if (element.type === "strike") {
    return `<s class="md-element rendered inline strike" ${common}>${text}</s>`;
  }

  if (element.type === "code") {
    return `<code class="md-element rendered inline code" ${common}>${text}</code>`;
  }

  if (element.type === "image") {
    return renderImagePreview(element, "md-element rendered inline image image-preview", common);
  }

  return `<span class="md-element rendered inline link" title="${escapeHtml(
    element.url ?? "",
  )}" ${common}>${text}</span>`;
}

function renderTableElement(element: MarkdownElement, common: string): string {
  const lines = element.text.split("\n").filter(Boolean);
  const header = splitTableRow(lines[0] ?? "");
  const rows = lines.slice(2).map(splitTableRow);
  const columnCount = Math.max(header.length, ...rows.map((row) => row.length));

  const renderCell = (value: string, tag: "td" | "th") =>
    `<${tag}>${escapeHtml(value)}</${tag}>`;
  const padRow = (row: string[]) =>
    Array.from({ length: columnCount }, (_, index) => row[index] ?? "");

  return `<table class="md-element rendered table" ${common}><thead><tr>${padRow(header)
    .map((cell) => renderCell(cell, "th"))
    .join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${padRow(row).map((cell) => renderCell(cell, "td")).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function renderEditingElement(element: MarkdownElement): string {
  const editingClasses = ["md-element", "editing", element.type];
  if (element.type === "heading" && element.level) {
    editingClasses.push(`heading-${element.level}`);
  }

  const common = `class="${editingClasses.join(" ")}" data-element-id="${escapeHtml(
    element.id,
  )}" data-full-start="${element.start}" data-full-end="${element.end}"`;

  if (element.type === "heading" || element.type === "blockquote") {
    const tokenEnd = element.contentStart;
    return `<span ${common}>${renderToken(markdown.slice(element.start, tokenEnd), element.start)}${renderSourceRun(
      element.text,
      element.contentStart,
      "content-run",
    )}</span>`;
  }

  if (element.type === "rule") {
    return `<span ${common}><span class="rule-edit-line" aria-hidden="true"></span>${renderSourceRun(
      markdown.slice(element.start, element.end),
      element.start,
      "rule-source-run",
    )}</span>`;
  }

  if (element.type === "codeblock") {
    return `<span ${common}>${renderToken(
      markdown.slice(element.start, element.contentStart),
      element.start,
    )}${renderHighlightedSourceRun(
      element.text,
      element.contentStart,
      element.language,
      "codeblock-source-run",
    )}${renderToken(markdown.slice(element.contentEnd, element.end), element.contentEnd)}</span>`;
  }

  if (element.type === "table") {
    return `<span ${common}>${renderSourceRun(
      markdown.slice(element.start, element.end),
      element.start,
      "table-source-run",
    )}</span>`;
  }

  if (element.type === "bold" || element.type === "strike") {
    return renderWrappedEditingElement(element, 2, common);
  }

  if (element.type === "italic" || element.type === "code") {
    return renderWrappedEditingElement(element, 1, common);
  }

  if (element.type === "image") {
    return `<span ${common}>${renderToken("![", element.start)}${renderSourceRun(
      element.text,
      element.contentStart,
      "content-run",
    )}${renderToken("](", element.contentEnd)}${renderSourceRun(
      element.url ?? "",
      element.urlStart ?? element.contentEnd + 2,
      "url-run",
    )}${renderToken(")", element.end - 1)}</span>`;
  }

  return `<span ${common}>${renderToken("[", element.start)}${renderSourceRun(
    element.text,
    element.contentStart,
    "content-run",
  )}${renderToken("](", element.contentEnd)}${renderSourceRun(
    element.url ?? "",
    element.urlStart ?? element.contentEnd + 2,
    "url-run",
  )}${renderToken(")", element.end - 1)}</span>`;
}

function renderWrappedEditingElement(
  element: MarkdownElement,
  tokenSize: number,
  common: string,
): string {
  return `<span ${common}>${renderToken(
    markdown.slice(element.start, element.contentStart),
    element.start,
  )}${renderSourceRun(element.text, element.contentStart, "content-run")}${renderToken(
    markdown.slice(element.contentEnd, element.end),
    element.end - tokenSize,
  )}</span>`;
}

function renderImagePreview(
  element: MarkdownElement,
  className: string,
  attributes: string,
): string {
  const alt = escapeHtml(element.text);
  const imageUrl = escapeHtml(element.url ?? "");
  const imageTitle = alt ? `${alt} - ${imageUrl}` : imageUrl;

  return `<span class="${className}" title="${escapeHtml(
    imageTitle,
  )}" data-alt="${alt}" data-url="${imageUrl}" ${attributes}><img src="${escapeHtml(
    element.url ?? "",
  )}" alt="${alt}" loading="lazy" /></span>`;
}

function renderToken(value: string, start: number): string {
  return renderSourceRun(value, start, "markdown-token");
}

function renderSourceRun(value: string, start: number, className = ""): string {
  if (!value) {
    return "";
  }

  return `<span class="source-run ${className}" data-start="${start}" data-end="${
    start + value.length
  }">${escapeHtml(value)}</span>`;
}

function renderHighlightedSourceRun(
  value: string,
  start: number,
  language = "",
  className = "",
): string {
  let cursor = start;

  return tokenizeCode(value, language)
    .map((token) => {
      const classes = ["source-run", className, token.className].filter(Boolean).join(" ");
      const html = `<span class="${classes}" data-start="${cursor}" data-end="${
        cursor + token.text.length
      }">${escapeHtml(token.text)}</span>`;
      cursor += token.text.length;
      return html;
    })
    .join("");
}

function highlightCode(value: string, language = ""): string {
  return tokenizeCode(value, language)
    .map((token) =>
      token.className
        ? `<span class="${token.className}">${escapeHtml(token.text)}</span>`
        : escapeHtml(token.text),
    )
    .join("");
}

function tokenizeCode(value: string, language = ""): CodeToken[] {
  const normalizedLanguage = language.toLowerCase();

  if (["ts", "tsx", "js", "jsx", "javascript", "typescript"].includes(normalizedLanguage)) {
    return tokenizeWithPattern(
      value,
      /(\/\/.*|\/\*[\s\S]*?\*\/|(["'`])(?:\\.|(?!\2)[\s\S])*\2|\b(?:async|await|break|case|catch|class|const|continue|default|else|export|extends|false|for|from|function|if|import|interface|let|new|null|return|throw|true|try|type|undefined|var|while)\b|\b\d+(?:\.\d+)?\b)/g,
      classifyScriptToken,
    );
  }

  if (normalizedLanguage === "json") {
    return tokenizeWithPattern(
      value,
      /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?\b/g,
      (token) => {
        if (/^"/.test(token)) {
          return token.trimEnd().endsWith(":") ? "syntax-key" : "syntax-string";
        }
        if (/^-?\d/.test(token)) {
          return "syntax-number";
        }
        return "syntax-keyword";
      },
    );
  }

  return [{ text: value }];
}

function tokenizeWithPattern(
  value: string,
  pattern: RegExp,
  classify: (token: string) => string,
): CodeToken[] {
  const tokens: CodeToken[] = [];
  let cursor = 0;

  for (const match of value.matchAll(pattern)) {
    const token = match[0];
    const index = match.index ?? cursor;
    if (index > cursor) {
      tokens.push({ text: value.slice(cursor, index) });
    }
    tokens.push({ text: token, className: classify(token) });
    cursor = index + token.length;
  }

  if (cursor < value.length) {
    tokens.push({ text: value.slice(cursor) });
  }

  return tokens;
}

function classifyScriptToken(token: string): string {
  if (token.startsWith("//") || token.startsWith("/*")) {
    return "syntax-comment";
  }

  if (/^["'`]/.test(token)) {
    return "syntax-string";
  }

  if (/^\d/.test(token)) {
    return "syntax-number";
  }

  return "syntax-keyword";
}

function handleKeydown(event: KeyboardEvent): void {
  if (isComposing || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }

  const selection = readSelection();
  if (!selection) {
    return;
  }

  const isTextInput = event.key.length === 1;
  const isMutationKey =
    isTextInput ||
    event.key === "Backspace" ||
    event.key === "Delete" ||
    event.key === "Enter" ||
    event.key === "Tab";

  if (event.key === "Escape") {
    event.preventDefault();
    activeElementIds.clear();
    render(selection.start);
    return;
  }

  if (
    (event.key === "ArrowUp" || event.key === "ArrowDown") &&
    selection.collapsed &&
    !event.shiftKey &&
    moveOutOfActiveRule(event.key, selection.start)
  ) {
    event.preventDefault();
    return;
  }

  if (isArrowNavigationKey(event.key) && selection.collapsed && !event.shiftKey) {
    queueArrowNavigation(event.key);
    return;
  }

  if (!isMutationKey) {
    return;
  }

  event.preventDefault();

  if (!selection.collapsed) {
    const resolved = resolveSelectionForMutation(selection);
    const inserted = event.key.length === 1 ? event.key : event.key === "Enter" ? "\n" : "";
    replaceRange(resolved.start, resolved.end, inserted);
    return;
  }

  const index = selection.start;

  if (event.key === " " && commitHorizontalRuleAtCaret(index)) {
    return;
  }

  if (event.key === "Backspace") {
    const leftElement = findElementAtBoundary(index, "left");
    if (leftElement && !activeElementIds.has(leftElement.id)) {
      activeElementIds.add(leftElement.id);
      render(leftElement.end);
      return;
    }

    if (index > 0) {
      replaceRange(index - 1, index, "");
    }
    return;
  }

  if (event.key === "Delete") {
    const rightElement = findElementAtBoundary(index, "right");
    if (rightElement && !activeElementIds.has(rightElement.id)) {
      activeElementIds.add(rightElement.id);
      render(rightElement.start);
      return;
    }

    if (index < markdown.length) {
      replaceRange(index, index + 1, "");
    }
    return;
  }

  const inserted = event.key === "Enter" ? "\n" : event.key === "Tab" ? "  " : event.key;
  replaceRange(index, index, inserted);
}

function moveOutOfActiveRule(key: "ArrowUp" | "ArrowDown", index: number): boolean {
  const activeRule = elements.find(
    (element) =>
      element.type === "rule" &&
      activeElementIds.has(element.id) &&
      index >= element.start &&
      index <= element.end,
  );

  if (!activeRule) {
    return false;
  }

  const lines = getSourceLines(markdown);
  const lineIndex = lines.findIndex((line) => line.start === activeRule.start);
  const targetLine = key === "ArrowUp" ? lines[lineIndex - 1] : lines[lineIndex + 1];

  if (!targetLine) {
    return false;
  }

  const targetElement = findElementForRuleTargetLine(targetLine, key);
  if (targetElement) {
    activeElementIds = new Set([targetElement.element.id]);
    render(targetElement.caret);
    return true;
  }

  activeElementIds.clear();
  render(key === "ArrowUp" ? targetLine.end : targetLine.start);
  return true;
}

function findElementForRuleTargetLine(
  line: { text: string; start: number; end: number },
  key: "ArrowUp" | "ArrowDown",
): { element: MarkdownElement; caret: number } | null {
  if (key === "ArrowDown") {
    const lineBlock = findLineBlockAt(line.start);
    if (lineBlock) {
      return { element: lineBlock, caret: lineBlock.contentStart };
    }

    const rightElement = findElementAtBoundary(line.start, "right");
    return rightElement ? { element: rightElement, caret: rightElement.contentStart } : null;
  }

  const containingBlock = findMultilineBlockContainingLine(line.start, line.end);
  if (containingBlock) {
    return { element: containingBlock, caret: containingBlock.contentEnd };
  }

  const leftElement = findElementAtBoundary(line.end, "left");
  return leftElement ? { element: leftElement, caret: leftElement.contentEnd } : null;
}

function isArrowNavigationKey(
  key: string,
): key is "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown";
}

function queueArrowNavigation(key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): void {
  window.requestAnimationFrame(() => {
    activateElementFromArrowNavigation(key);
  });
}

function activateElementFromArrowNavigation(
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
): void {
  if (!editorEl || document.activeElement !== editorEl || isRendering || isComposing) {
    return;
  }

  const selection = readSelection();
  if (!selection || !selection.collapsed) {
    return;
  }

  const index = selection.start;
  const boundaryHit = findElementFromArrowBoundary(index, key);

  if (!boundaryHit || activeElementIds.has(boundaryHit.element.id)) {
    return;
  }

  activeElementIds = new Set([boundaryHit.element.id]);
  render(boundaryHit.caret);
}

function findElementFromArrowBoundary(
  index: number,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
): { element: MarkdownElement; caret: number } | null {
  if (key === "ArrowRight") {
    const element = findElementAtBoundary(index, "right") ?? findElementAfterLineBreakBoundary(index);
    return element ? { element, caret: element.contentStart } : null;
  }

  if (key === "ArrowLeft") {
    const element = findElementAtBoundary(index, "left") ?? findElementBeforeLineBreakBoundary(index);
    return element ? { element, caret: element.contentEnd } : null;
  }

  const rightElement = findElementAtBoundary(index, "right");
  if (rightElement) {
    return { element: rightElement, caret: rightElement.contentStart };
  }

  const leftElement = findElementAtBoundary(index, "left");
  if (leftElement) {
    return { element: leftElement, caret: leftElement.contentEnd };
  }

  return null;
}

function findElementAfterLineBreakBoundary(index: number): MarkdownElement | null {
  return (
    elements.find((element) => {
      if (element.start <= index) {
        return false;
      }

      return markdown.slice(index, element.start) === "\n";
    }) ?? null
  );
}

function findElementBeforeLineBreakBoundary(index: number): MarkdownElement | null {
  return (
    [...elements].reverse().find((element) => {
      if (element.end >= index) {
        return false;
      }

      return markdown.slice(element.end, index) === "\n";
    }) ?? null
  );
}

function commitHorizontalRuleAtCaret(index: number): boolean {
  const line = getSourceLineAt(index);
  const afterCaret = markdown.slice(index, line.end);

  if (!isHorizontalRuleSource(line.text) || afterCaret.trim().length > 0) {
    return false;
  }

  const marker = line.text.trim();
  const hasLineBreak = markdown[line.end] === "\n";
  const replacement = hasLineBreak ? marker : `${marker}\n`;
  const nextCaret = line.start + marker.length + 1;

  markdown = `${markdown.slice(0, line.start)}${replacement}${markdown.slice(line.end)}`;
  activeElementIds.clear();
  render(nextCaret);
  return true;
}

function completeActiveRuleOnCaretLeave(caret: number): boolean {
  const activeRule = elements.find(
    (element) => element.type === "rule" && activeElementIds.has(element.id),
  );

  if (!activeRule || (caret >= activeRule.start && caret <= activeRule.end)) {
    return false;
  }

  if (markdown[activeRule.end] === "\n") {
    return false;
  }

  markdown = `${markdown.slice(0, activeRule.end)}\n${markdown.slice(activeRule.end)}`;
  activeElementIds.clear();
  render(caret > activeRule.end ? caret + 1 : caret);
  return true;
}

function handleBeforeInput(event: InputEvent): void {
  if (!isComposing) {
    return;
  }

  if (event.inputType === "insertCompositionText" && event.data) {
    pendingCompositionText = event.data;
  }
}

function commitComposition(event: CompositionEvent): void {
  const inserted = event.data || pendingCompositionText;
  const range = compositionRange;

  compositionRange = null;
  pendingCompositionText = "";

  if (!range || !inserted) {
    render(range?.start ?? markdown.length);
    return;
  }

  const resolved = range.collapsed ? range : resolveSelectionForMutation(range);
  replaceRange(resolved.start, resolved.end, inserted);
}

function handlePointerDown(event: PointerEvent): void {
  if (isComposing) {
    return;
  }

  const target = event.target instanceof Element ? event.target : null;
  const renderedElement = target?.closest<HTMLElement>(".md-element.rendered");
  if (!renderedElement) {
    queueSelectionSync();
    return;
  }

  const id = renderedElement.dataset.elementId;
  if (!id) {
    return;
  }

  event.preventDefault();
  const fallback =
    renderedElement.dataset.elementType === "image"
      ? Number(renderedElement.dataset.urlEnd)
      : Number(renderedElement.dataset.end);
  activeElementIds = new Set([id]);
  render(fallback);
}

async function handlePaste(event: ClipboardEvent): Promise<void> {
  const selection = readSelection();
  if (!selection) {
    return;
  }

  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (text) {
    event.preventDefault();
    const range = selection.collapsed ? selection : resolveSelectionForMutation(selection);
    replaceRange(range.start, range.end, text);
    return;
  }

  const imageFiles = getImageFiles(event.clipboardData);
  if (imageFiles.length === 0) {
    return;
  }

  event.preventDefault();
  await insertClipboardImageFiles(imageFiles);
}

function handleDragOver(event: DragEvent): void {
  if (!hasImageFile(event.dataTransfer)) {
    return;
  }

  event.preventDefault();
  event.dataTransfer!.dropEffect = "copy";
}

function handleBrowserDrop(event: DragEvent): void {
  if (!hasImageFile(event.dataTransfer)) {
    return;
  }

  event.preventDefault();
  updateStatus("Use the desktop app drop target to copy local images into assets");
}

async function handleTauriDragDrop(event: DragDropEvent): Promise<void> {
  if (event.type !== "drop") {
    return;
  }

  const imagePaths = event.paths.filter(isLikelyImagePath);
  if (imagePaths.length === 0) {
    return;
  }

  await insertDroppedImagePaths(imagePaths);
}

async function insertDroppedImagePaths(paths: string[]): Promise<void> {
  if (!isTauri()) {
    updateStatus("Image assets are available in the desktop app");
    return;
  }

  try {
    const snippets = await Promise.all(
      paths.map(async (sourcePath) => {
        const prepared = await invoke<PreparedImageAsset>("prepare_image_asset", {
          sourcePath,
          documentPath: editorContext.documentPath,
          projectRoot: editorContext.projectRoot,
        });
        return markdownImageSnippet(altFromPath(sourcePath), prepared.markdownPath);
      }),
    );

    insertMarkdownAtSelection(snippets.join("\n"));
    updateStatus(paths.length === 1 ? "Image inserted" : `${paths.length} images inserted`);
  } catch (error) {
    updateStatus(`Image insert failed: ${String(error)}`);
  }
}

async function insertClipboardImageFiles(files: File[]): Promise<void> {
  if (!isTauri()) {
    updateStatus("Image paste needs the desktop app to copy into assets");
    return;
  }

  try {
    const snippets = await Promise.all(
      files.map(async (file, index) => {
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
        const prepared = await invoke<PreparedImageAsset>("save_image_asset", {
          bytes,
          suggestedName: file.name || `pasted-image-${index + 1}.${extensionFromMime(file.type)}`,
          documentPath: editorContext.documentPath,
        });
        return markdownImageSnippet(altFromPath(file.name || "pasted image"), prepared.markdownPath);
      }),
    );

    insertMarkdownAtSelection(snippets.join("\n"));
    updateStatus(files.length === 1 ? "Image pasted into assets" : `${files.length} images pasted into assets`);
  } catch (error) {
    updateStatus(`Image paste failed: ${String(error)}`);
  }
}

function insertMarkdownAtSelection(value: string): void {
  const selection = readSelection();
  const range = selection
    ? selection.collapsed
      ? selection
      : resolveSelectionForMutation(selection)
    : { start: markdown.length, end: markdown.length, collapsed: true };

  replaceRange(range.start, range.end, value);
}

function getImageFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) {
    return [];
  }

  return [...dataTransfer.files].filter((file) => file.type.startsWith("image/"));
}

function hasImageFile(dataTransfer: DataTransfer | null): boolean {
  return getImageFiles(dataTransfer).length > 0;
}

function isLikelyImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(path);
}

function markdownImageSnippet(alt: string, path: string): string {
  return `![${escapeMarkdownLabel(alt)}](${path})`;
}

function altFromPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "image";
  return name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "image";
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function extensionFromMime(mime: string): string {
  if (mime === "image/jpeg") {
    return "jpg";
  }
  if (mime === "image/gif") {
    return "gif";
  }
  if (mime === "image/webp") {
    return "webp";
  }
  if (mime === "image/svg+xml") {
    return "svg";
  }
  if (mime === "image/bmp") {
    return "bmp";
  }

  return "png";
}

function handleMouseup(): void {
  if (isComposing) {
    return;
  }

  const selection = readSelection();
  if (!selection || selection.collapsed) {
    queueSelectionSync();
    return;
  }

  const affected = elements.filter((element) =>
    rangesOverlap(selection.start, selection.end, element.contentStart, element.contentEnd),
  );

  if (affected.length === 0) {
    return;
  }

  activeElementIds = new Set(affected.map((element) => element.id));
  const resolved = resolveSelectionForMutation(selection);
  render(resolved.start, resolved.end);
}

function replaceRange(start: number, end: number, inserted: string): void {
  markdown = `${markdown.slice(0, start)}${inserted}${markdown.slice(end)}`;
  const caret = start + inserted.length;
  activeElementIds = new Set(
    parseMarkdown(markdown)
      .filter((element) => caret >= element.start && caret <= element.end)
      .map((element) => element.id),
  );
  render(caret);
}

function resolveSelectionForMutation(selection: SourceSelection): SourceSelection {
  let start = Math.min(selection.start, selection.end);
  let end = Math.max(selection.start, selection.end);
  const affected = elements.filter((element) =>
    rangesOverlap(start, end, element.contentStart, element.contentEnd),
  );

  for (const element of affected) {
    const crossesBoundary = start < element.contentStart || end > element.contentEnd;
    if (crossesBoundary) {
      start = Math.min(start, element.start);
      end = Math.max(end, element.end);
    }
  }

  activeElementIds = new Set(affected.map((element) => element.id));
  return { start, end, collapsed: start === end };
}

function queueSelectionSync(): void {
  if (pendingSelectionSync || isRendering || isComposing) {
    return;
  }

  pendingSelectionSync = window.requestAnimationFrame(() => {
    pendingSelectionSync = 0;
    syncSelectionState();
  });
}

function syncSelectionState(): void {
  if (!editorEl || document.activeElement !== editorEl || isRendering || isComposing) {
    return;
  }

  const selection = readSelection();
  if (!selection || !selection.collapsed) {
    return;
  }

  if (completeActiveRuleOnCaretLeave(selection.start)) {
    return;
  }

  const target = findElementForCaret(selection.start);
  const nextActiveIds = new Set<string>();

  if (target) {
    nextActiveIds.add(target.id);
  }

  if (!sameSet(activeElementIds, nextActiveIds)) {
    activeElementIds = nextActiveIds;
    render(selection.start);
  }
}

function readSelection(): SourceSelection | null {
  const selection = window.getSelection();
  if (!editorEl || !selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (
    !editorEl.contains(range.startContainer) ||
    !editorEl.contains(range.endContainer)
  ) {
    return null;
  }

  const start = sourceIndexFromDomPoint(
    range.startContainer,
    range.startOffset,
    selection.isCollapsed,
  );
  const end = sourceIndexFromDomPoint(
    range.endContainer,
    range.endOffset,
    selection.isCollapsed,
  );

  if (start === null || end === null) {
    return null;
  }

  return {
    start: Math.min(start, end),
    end: Math.max(start, end),
    collapsed: selection.isCollapsed,
  };
}

function sourceIndexFromDomPoint(
  node: Node,
  offset: number,
  useRenderedBoundary: boolean,
): number | null {
  const textNode = node.nodeType === Node.TEXT_NODE ? node : null;
  const element =
    textNode?.parentElement ??
    (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : null);
  const sourceNode = element?.closest<HTMLElement>("[data-start][data-end]");

  if (!sourceNode) {
    return null;
  }

  const start = Number(sourceNode.dataset.start);
  const end = Number(sourceNode.dataset.end);

  if (sourceNode.dataset.rendered === "true" && useRenderedBoundary && textNode) {
    const fullStart = Number(sourceNode.dataset.fullStart);
    const fullEnd = Number(sourceNode.dataset.fullEnd);
    const textLength = textNode.textContent?.length ?? 0;
    if (offset === 0) {
      return fullStart;
    }
    if (offset === textLength) {
      return fullEnd;
    }
  }

  if (textNode) {
    return clamp(start + offset, start, end);
  }

  return offset === 0 ? start : end;
}

function setSelectionBySourceRange(start: number, end = start): void {
  const selection = window.getSelection();
  const startPoint = domPointFromSourceIndex(start);
  const endPoint = domPointFromSourceIndex(end);

  if (!selection || !startPoint || !endPoint) {
    return;
  }

  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

function domPointFromSourceIndex(index: number): { node: Node; offset: number } | null {
  if (!editorEl) {
    return null;
  }

  const runs = [...editorEl.querySelectorAll<HTMLElement>("[data-start][data-end]")];

  for (const run of runs) {
    const start = Number(run.dataset.start);
    const end = Number(run.dataset.end);
    if (index < start || index > end) {
      continue;
    }

    const textNode = [...run.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
    if (!textNode) {
      continue;
    }

    const textLength = textNode.textContent?.length ?? 0;
    return {
      node: textNode,
      offset: clamp(index - start, 0, textLength),
    };
  }

  const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;
  const lastText = lastRun
    ? [...lastRun.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)
    : null;

  if (lastText) {
    return { node: lastText, offset: lastText.textContent?.length ?? 0 };
  }

  return null;
}

function findElementAtBoundary(index: number, side: "left" | "right"): MarkdownElement | null {
  return (
    elements.find((element) =>
      side === "left" ? element.end === index : element.start === index,
    ) ?? null
  );
}

function findLineBlockAt(start: number): MarkdownElement | null {
  return (
    elements.find(
      (element) =>
        (element.type === "blockquote" ||
          element.type === "rule" ||
          element.type === "table" ||
          element.type === "codeblock") &&
        element.start === start,
    ) ?? null
  );
}

function findMultilineBlockContainingLine(start: number, end: number): MarkdownElement | null {
  return (
    elements.find(
      (element) =>
        (element.type === "table" || element.type === "codeblock") &&
        start >= element.start &&
        end <= element.end,
    ) ?? null
  );
}

function isInlineElement(element: MarkdownElement): boolean {
  return (
    element.type === "bold" ||
    element.type === "italic" ||
    element.type === "strike" ||
    element.type === "code" ||
    element.type === "image" ||
    element.type === "link"
  );
}

function findElementContaining(index: number): MarkdownElement | null {
  return (
    elements.find((element) => index > element.start && index < element.end) ?? null
  );
}

function findElementForCaret(index: number): MarkdownElement | null {
  const activeElement = elements.find(
    (element) =>
      activeElementIds.has(element.id) && index >= element.start && index <= element.end,
  );

  return activeElement ?? findElementContaining(index);
}

function updateStatus(message?: string): void {
  if (!statusEl) {
    return;
  }

  if (message) {
    statusEl.textContent = message;
    return;
  }

  const active = activeElementIds.size
    ? `${activeElementIds.size} editing element${activeElementIds.size > 1 ? "s" : ""}`
    : "all rendered";
  statusEl.textContent = `${active} · ${markdown.length} source chars`;
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function sameSet<T>(left: Set<T>, right: Set<T>): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
