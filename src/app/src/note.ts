import { invoke, isTauri } from "@tauri-apps/api/core";
import "./note-window.css";

type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

type TauriWindow = {
  hide(): Promise<void>;
  setAlwaysOnTop(alwaysOnTop: boolean): Promise<void>;
  startDragging(): Promise<void>;
  startResizeDragging(direction: ResizeDirection): Promise<void>;
};

const root = document.querySelector<HTMLDivElement>("#note");

if (!root) {
  throw new Error("Note root element was not found.");
}

const rawParams = window.location.hash.startsWith("#")
  ? window.location.hash.slice(1)
  : window.location.search;
const params = new URLSearchParams(rawParams);
const title = params.get("title") ?? "untitled.md";
const relativePath = params.get("file") ?? "";
const rawOpacity = Number(params.get("opacity") ?? "100");
const initialOpacity = Number.isFinite(rawOpacity)
  ? Math.max(35, Math.min(rawOpacity, 100))
  : 100;
const initialAlwaysOnTop = params.get("alwaysOnTop") !== "false";

let nativeWindowPromise: Promise<TauriWindow | null> | null = null;
let pinned = initialAlwaysOnTop;
let saveTimer: number | undefined;

const fallbackContentByTitle: Record<string, string> = {
  "weekly-sync.md": `# Weekly Sync

- [x] Tray file state model
- [x] Opacity range
- [ ] Layout preset restore
- [ ] Hotkey conflict flow
`,
  "release-0.3.md": `# Release 0.3

- [x] Global hotkey
- [ ] Window opacity persistence
- [ ] Tray visibility flow
`,
  "scratch-pad.md": `# Scratch Pad

빠르게 붙잡아 둘 생각을 적는 임시 메모입니다.
`,
};

const make = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
};

const shell = make("main", "note-shell");
shell.dataset.pinned = String(pinned);

const bar = make("header", "note-bar");
bar.setAttribute("aria-label", "Window drag handle");

const grip = make("span", "note-grip");
grip.setAttribute("aria-hidden", "true");
grip.append(make("i"), make("i"), make("i"));

const identity = make("span", "note-identity");
const titleEl = make("span", "note-title", title);
const pathEl = make("span", "note-path", relativePath || "Preview note");
identity.append(titleEl, pathEl);

const statusEl = make("span", "note-status", "Loading");
statusEl.setAttribute("role", "status");

const controls = make("span", "note-controls");

const opacityControl = make("label", "opacity-control");
opacityControl.setAttribute("aria-label", "메모 투명도");
const opacityReadout = make("span", "opacity-readout", `${initialOpacity}%`);
const opacitySlider = make("input", "opacity-slider");
opacitySlider.type = "range";
opacitySlider.min = "35";
opacitySlider.max = "100";
opacitySlider.step = "1";
opacitySlider.value = String(initialOpacity);
opacityControl.append(opacityReadout, opacitySlider);

const pinButton = make("button", pinned ? "note-icon note-pin is-active" : "note-icon note-pin");
pinButton.type = "button";
pinButton.setAttribute("aria-label", "항상 위 고정");
pinButton.setAttribute("aria-pressed", String(pinned));
pinButton.title = "항상 위 고정";
const pinIcon = make("span", "icon icon-pin");
pinIcon.setAttribute("aria-hidden", "true");
pinButton.append(pinIcon);

const hideButton = make("button", "note-icon note-hide");
hideButton.type = "button";
hideButton.setAttribute("aria-label", "메모 숨기기");
hideButton.title = "메모 숨기기";
const hideIcon = make("span", "icon icon-hide");
hideIcon.setAttribute("aria-hidden", "true");
hideButton.append(hideIcon);

controls.append(opacityControl, pinButton, hideButton);
bar.append(grip, identity, statusEl, controls);

const editor = make("textarea", "note-editor");
editor.spellcheck = false;
editor.setAttribute("aria-label", "Markdown editor");

const resizeGrip = make("button", "resize-grip");
resizeGrip.type = "button";
resizeGrip.setAttribute("aria-label", "창 크기 조절");
resizeGrip.title = "창 크기 조절";
resizeGrip.append(make("span"));

shell.append(bar, editor, resizeGrip);
root.replaceChildren(shell);
document.body.dataset.ready = "true";

const setStatus = (value: string): void => {
  statusEl.textContent = value;
};

const getNativeWindow = (): Promise<TauriWindow | null> => {
  if (!isTauri()) {
    return Promise.resolve(null);
  }

  nativeWindowPromise ??= import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow() as TauriWindow)
    .catch((error) => {
      console.error(error);
      return null;
    });
  return nativeWindowPromise;
};

const setVisualOpacity = (percent: number): void => {
  const clamped = Math.max(35, Math.min(percent, 100));
  document.documentElement.style.setProperty("--note-opacity", `${clamped / 100}`);
  opacitySlider.value = String(clamped);
  opacityReadout.textContent = `${clamped}%`;
};

const isInteractiveTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  Boolean(target.closest("button, input, textarea, label, .note-controls"));

const startWindowDrag = (event: PointerEvent): void => {
  if (event.button !== 0 || isInteractiveTarget(event.target)) {
    return;
  }

  event.preventDefault();
  void getNativeWindow().then((window) =>
    window?.startDragging().catch((error) => {
      console.error(error);
      setStatus("Drag unavailable");
    }),
  );
};

const startWindowResize = (direction: ResizeDirection): void => {
  void getNativeWindow().then((window) =>
    window?.startResizeDragging(direction).catch((error) => {
      console.error(error);
      setStatus("Resize unavailable");
    }),
  );
};

const loadContent = async (): Promise<void> => {
  if (!isTauri() || !relativePath) {
    editor.value = fallbackContentByTitle[title] ?? "# New Note\n\nMarkdown을 작성하세요.\n";
    setStatus("Preview");
    return;
  }

  try {
    editor.value = await invoke<string>("read_markdown_file", {
      relativePath,
    });
    setStatus("Saved");
  } catch (error) {
    console.error(error);
    editor.value = fallbackContentByTitle[title] ?? "# New Note\n\n파일을 읽지 못했습니다.\n";
    setStatus("Read failed");
  }
};

editor.addEventListener("input", () => {
  if (!isTauri() || !relativePath) {
    setStatus("Preview edit");
    return;
  }

  setStatus("Editing");
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      await invoke("write_markdown_file", {
        relativePath,
        content: editor.value,
      });
      setStatus("Saved");
    } catch (error) {
      console.error(error);
      setStatus("Save failed");
    }
  }, 500);
});

bar.addEventListener("pointerdown", startWindowDrag);

opacitySlider.addEventListener("input", () => {
  setVisualOpacity(Number(opacitySlider.value));
});

pinButton.addEventListener("click", async () => {
  pinned = !pinned;
  shell.dataset.pinned = String(pinned);
  pinButton.classList.toggle("is-active", pinned);
  pinButton.setAttribute("aria-pressed", String(pinned));

  const window = await getNativeWindow();
  if (!window) {
    setStatus(pinned ? "Pinned preview" : "Unpinned preview");
    return;
  }

  try {
    await window.setAlwaysOnTop(pinned);
    setStatus(pinned ? "Pinned" : "Unpinned");
  } catch (error) {
    console.error(error);
    setStatus("Pin failed");
  }
});

hideButton.addEventListener("click", async () => {
  const window = await getNativeWindow();
  if (!window) {
    setStatus("Hide needs Tauri");
    return;
  }

  try {
    await window.hide();
  } catch (error) {
    console.error(error);
    setStatus("Hide failed");
  }
});

resizeGrip.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  startWindowResize("SouthEast");
});

setVisualOpacity(initialOpacity);
void loadContent();
