import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root element was not found.");
}

const appRoot: HTMLDivElement = app;

type NoteState = "focus" | "open" | "closed";
type ThemeKey = "workbench" | "instrument" | "playos";

type Note = {
  name: string;
  meta: string;
  state: NoteState;
  path: string;
};

type NativeStatus = {
  nativeReady: boolean;
  shortcutRegistered: boolean;
  defaultShortcut: string;
};

type ShortcutTrigger = {
  shortcut: string;
  sequence: number;
};

type NativeMarkdownTreeNode = {
  kind: "folder" | "note";
  name: string;
  path: string;
  children: NativeMarkdownTreeNode[];
};

type WorkspaceState = {
  theme?: ThemeKey;
  defaultNoteOpacity?: number;
  defaultAlwaysOnTop?: boolean;
};

type TreeNode =
  | {
      type: "folder";
      name: string;
      meta: string;
      open: boolean;
      children: TreeNode[];
    }
  | {
      type: "note";
      note: Note;
    };

const themes: ThemeKey[] = ["workbench", "instrument", "playos"];

const fallbackTree: TreeNode[] = [
  {
    type: "folder",
    name: "Work",
    meta: "3",
    open: true,
    children: [
      {
        type: "note",
        note: { name: "weekly-sync.md", meta: "md", state: "closed", path: "Work/weekly-sync.md" },
      },
      {
        type: "note",
        note: { name: "release-0.3.md", meta: "md", state: "closed", path: "Work/release-0.3.md" },
      },
      {
        type: "note",
        note: { name: "hotkey-map.md", meta: "md", state: "closed", path: "Work/hotkey-map.md" },
      },
    ],
  },
  {
    type: "folder",
    name: "Capture",
    meta: "2",
    open: true,
    children: [
      {
        type: "note",
        note: { name: "scratch-pad.md", meta: "md", state: "closed", path: "Capture/scratch-pad.md" },
      },
      {
        type: "note",
        note: { name: "daily-log.md", meta: "md", state: "closed", path: "Capture/daily-log.md" },
      },
    ],
  },
  {
    type: "folder",
    name: "Reference",
    meta: "1",
    open: true,
    children: [
      {
        type: "note",
        note: { name: "reading-list.md", meta: "md", state: "closed", path: "Reference/reading-list.md" },
      },
    ],
  },
];

let currentTree: TreeNode[] = fallbackTree;
let activeTheme: ThemeKey = "workbench";
let defaultNoteOpacity = 100;
let defaultAlwaysOnTop = true;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const countNotes = (nodes: TreeNode[]): number =>
  nodes.reduce((count, node) => {
    if (node.type === "note") {
      return count + 1;
    }
    return count + countNotes(node.children);
  }, 0);

const noteRow = (note: Note): string => `
  <li>
    <button class="note is-${note.state}" type="button" data-path="${escapeHtml(note.path)}">
      <span class="note__dot" aria-hidden="true"></span>
      <span class="note__body">
        <span class="note__name">${escapeHtml(note.name)}</span>
        <span class="note__path">${escapeHtml(note.path)}</span>
      </span>
    </button>
  </li>
`;

const treeNode = (node: TreeNode): string => {
  if (node.type === "note") {
    return noteRow(node.note);
  }

  return `
    <li class="tree-folder ${node.open ? "is-open" : ""}">
      <button class="folder" type="button" aria-expanded="${node.open}">
        <span class="folder__twist" aria-hidden="true"></span>
        <span class="folder__name">${escapeHtml(node.name)}</span>
        <span class="folder__meta">${escapeHtml(node.meta)}</span>
      </button>
      <ul class="tree-children">
        ${node.children.map(treeNode).join("")}
      </ul>
    </li>
  `;
};

app.innerHTML = `
  <div class="app">
    <header class="topbar panel">
      <div class="brand">
        <span class="logo" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="brand__text">
          <span class="brand__name">Memstick</span>
          <span class="brand__kind">Markdown Stickies</span>
        </span>
      </div>
      <div class="topbar__right">
        <div class="hotkey" role="status">
          <span class="hotkey__pulse" aria-hidden="true"></span>
          <span class="hotkey__label">Native checking</span>
          <span class="combo"><kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>Space</kbd></span>
        </div>
        <button class="settings-button" type="button" aria-label="Open settings">Settings</button>
      </div>
    </header>

    <main class="file-picker panel" aria-label="Markdown files">
      <div class="file-picker__head">
        <div>
          <span class="eyebrow">Files</span>
          <h1>Markdown</h1>
        </div>
        <span class="file-count">0 files</span>
      </div>

      <label class="finder">
        <span class="finder__label">Filename</span>
        <input type="text" placeholder="파일 이름으로 찾기" aria-label="파일 이름 검색" />
      </label>

      <ul class="tree" aria-label="Markdown file tree">
        ${fallbackTree.map(treeNode).join("")}
      </ul>
    </main>

    <footer class="statusbar panel">
      <span class="status-text">md 파일을 클릭하면 별도 sticky window로 열립니다.</span>
    </footer>
  </div>
`;

const treeList = app.querySelector<HTMLUListElement>(".tree");
const finderInput = app.querySelector<HTMLInputElement>(".finder input");
const hotkeyLabel = app.querySelector<HTMLElement>(".hotkey__label");
const statusText = app.querySelector<HTMLElement>(".status-text");
const fileCount = app.querySelector<HTMLElement>(".file-count");
const settingsButton = app.querySelector<HTMLButtonElement>(".settings-button");

function setStatus(value: string): void {
  if (statusText) {
    statusText.textContent = value;
  }
}

function setHotkeyStatus(value: string): void {
  if (hotkeyLabel) {
    hotkeyLabel.textContent = value;
  }
}

function fromNativeTree(nodes: NativeMarkdownTreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.kind === "note") {
      return {
        type: "note",
        note: {
          name: node.name,
          meta: "md",
          state: "closed",
          path: node.path,
        },
      };
    }

    const children = fromNativeTree(node.children);
    return {
      type: "folder",
      name: node.name,
      meta: String(countNotes(children)),
      open: true,
      children,
    };
  });
}

function filterTreeByFileName(nodes: TreeNode[], query: string): TreeNode[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return nodes;
  }

  return nodes.flatMap((node): TreeNode[] => {
    if (node.type === "note") {
      return node.note.name.toLowerCase().includes(normalized) ? [node] : [];
    }

    const children = filterTreeByFileName(node.children, normalized);
    return children.length > 0
      ? [
          {
            ...node,
            open: true,
            children,
          },
        ]
      : [];
  });
}

function findNoteByPath(nodes: TreeNode[], path: string): Note | null {
  for (const node of nodes) {
    if (node.type === "note" && node.note.path === path) {
      return node.note;
    }
    if (node.type === "folder") {
      const child = findNoteByPath(node.children, path);
      if (child) {
        return child;
      }
    }
  }
  return null;
}

function markOpen(path: string): void {
  appRoot.querySelectorAll<HTMLButtonElement>(".note").forEach((row) => {
    const active = row.dataset.path === path;
    row.classList.toggle("is-focus", active);
    if (active) {
      row.classList.remove("is-closed");
      row.classList.add("is-open");
    }
  });
}

async function openNote(note: Note): Promise<void> {
  markOpen(note.path);

  if (!isTauri()) {
    setStatus("Tauri 앱에서 실행해야 sticky window가 열립니다.");
    return;
  }

  try {
    await invoke<string>("open_markdown_window", {
      relativePath: note.path,
      opacity: defaultNoteOpacity,
      alwaysOnTop: defaultAlwaysOnTop,
    });
    setStatus(`${note.name} opened`);
  } catch (error) {
    console.error(error);
    setStatus(`${note.name} 열기 실패`);
  }
}

function renderTree(): void {
  if (!treeList) {
    return;
  }

  const filtered = filterTreeByFileName(currentTree, finderInput?.value ?? "");
  treeList.innerHTML =
    filtered.length > 0
      ? filtered.map(treeNode).join("")
      : `<li class="tree-empty">일치하는 파일명이 없습니다.</li>`;
  bindTreeInteractions();
  if (fileCount) {
    fileCount.textContent = `${countNotes(currentTree)} files`;
  }
}

function bindTreeInteractions(): void {
  appRoot.querySelectorAll<HTMLButtonElement>(".note").forEach((row) => {
    row.addEventListener("click", () => {
      const path = row.dataset.path;
      if (!path) {
        return;
      }

      const note = findNoteByPath(currentTree, path);
      if (note) {
        void openNote(note);
      }
    });
  });

  appRoot.querySelectorAll<HTMLButtonElement>(".folder").forEach((folder) => {
    folder.addEventListener("click", () => {
      const item = folder.closest(".tree-folder");
      if (!(item instanceof HTMLElement)) {
        return;
      }
      item.classList.toggle("is-open");
      folder.setAttribute("aria-expanded", String(item.classList.contains("is-open")));
    });
  });
}

async function bootNativeShell(): Promise<void> {
  if (!isTauri()) {
    setHotkeyStatus("Preview Mode");
    renderTree();
    return;
  }

  try {
    const status = await invoke<NativeStatus>("native_status");
    setHotkeyStatus(
      status.shortcutRegistered ? `${status.defaultShortcut} Ready` : "Hotkey 등록 실패",
    );

    const nativeTree = await invoke<NativeMarkdownTreeNode[]>("scan_markdown_tree");
    currentTree = nativeTree.length > 0 ? fromNativeTree(nativeTree) : [];
    renderTree();

    await listen<ShortcutTrigger>("shortcut-triggered", (event) => {
      setHotkeyStatus(`Hotkey #${event.payload.sequence}`);
    });

    await listen<WorkspaceState>("settings-updated", (event) => {
      applyWorkspaceState(event.payload);
      setStatus("Settings updated");
    });
  } catch (error) {
    console.error(error);
    setHotkeyStatus("Native 연결 실패");
    renderTree();
  }
}

function applyTheme(key: ThemeKey): void {
  activeTheme = key;
  document.body.dataset.theme = key;
}

function applyWorkspaceState(state: WorkspaceState | null | undefined): void {
  if (!state) {
    return;
  }

  if (state.theme && themes.includes(state.theme)) {
    applyTheme(state.theme);
  }

  if (typeof state.defaultNoteOpacity === "number") {
    defaultNoteOpacity = Math.max(35, Math.min(Math.round(state.defaultNoteOpacity), 100));
  }

  if (typeof state.defaultAlwaysOnTop === "boolean") {
    defaultAlwaysOnTop = state.defaultAlwaysOnTop;
  }
}

async function restoreWorkspaceState(): Promise<void> {
  try {
    const state = isTauri()
      ? await invoke<WorkspaceState | null>("load_workspace_state")
      : JSON.parse(localStorage.getItem("memstick.workspaceState") ?? "null");
    applyWorkspaceState(state);
  } catch (error) {
    console.error(error);
  }
}

async function openSettings(): Promise<void> {
  if (!isTauri()) {
    window.open("/settings.html", "memstick-settings", "width=460,height=420");
    return;
  }

  try {
    await invoke("open_settings_window");
  } catch (error) {
    console.error(error);
    setStatus("Settings 열기 실패");
  }
}

finderInput?.addEventListener("input", renderTree);
settingsButton?.addEventListener("click", () => {
  void openSettings();
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const isTextEntry =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable);

  if (isTextEntry || event.metaKey) {
    return;
  }

  if (event.key === "Enter") {
    const focused = document.activeElement;
    if (focused instanceof HTMLButtonElement && focused.classList.contains("note")) {
      focused.click();
    }
  }
});

applyTheme(activeTheme);
renderTree();
void bootNativeShell();
void restoreWorkspaceState();
