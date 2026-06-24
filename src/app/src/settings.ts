import { invoke, isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import "./settings.css";

type ThemeKey = "workbench" | "instrument" | "playos";

type WorkspaceState = {
  theme: ThemeKey;
  defaultNoteOpacity: number;
  defaultAlwaysOnTop: boolean;
};

const root = document.querySelector<HTMLDivElement>("#settings");

if (!root) {
  throw new Error("Settings root element was not found.");
}

const themes: Array<{ key: ThemeKey; label: string }> = [
  { key: "workbench", label: "Workbench" },
  { key: "instrument", label: "Instrument" },
  { key: "playos", label: "Color OS" },
];

let state: WorkspaceState = {
  theme: "workbench",
  defaultNoteOpacity: 100,
  defaultAlwaysOnTop: true,
};

let saveTimer: number | undefined;

root.innerHTML = `
  <main class="settings-shell">
    <header class="settings-head">
      <div>
        <span class="eyebrow">Settings</span>
        <h1>Memstick</h1>
      </div>
      <span class="save-state" role="status">Ready</span>
    </header>

    <section class="setting-row">
      <div>
        <h2>Theme</h2>
        <p>메인 파일 선택기 색감</p>
      </div>
      <div class="theme-options" role="radiogroup" aria-label="Theme">
        ${themes
          .map(
            (theme) =>
              `<button class="theme-option" type="button" data-theme="${theme.key}" role="radio">${theme.label}</button>`,
          )
          .join("")}
      </div>
    </section>

    <section class="setting-row">
      <div>
        <h2>Global Hotkey</h2>
        <p>변경 기능은 다음 단계</p>
      </div>
      <div class="hotkey-field">
        <kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>Space</kbd>
        <span>Soon</span>
      </div>
    </section>

    <section class="setting-row">
      <div>
        <h2>Note Opacity</h2>
        <p>새 sticky window 기본값</p>
      </div>
      <label class="range-field">
        <span class="opacity-value">100%</span>
        <input class="opacity-input" type="range" min="35" max="100" step="1" value="100" />
      </label>
    </section>

    <section class="setting-row">
      <div>
        <h2>Always on Top</h2>
        <p>새 메모를 화면 위에 고정</p>
      </div>
      <label class="switch">
        <input class="always-input" type="checkbox" checked />
        <span aria-hidden="true"></span>
      </label>
    </section>
  </main>
`;

const statusEl = root.querySelector<HTMLElement>(".save-state");
const themeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>(".theme-option"));
const opacityInput = root.querySelector<HTMLInputElement>(".opacity-input");
const opacityValue = root.querySelector<HTMLElement>(".opacity-value");
const alwaysInput = root.querySelector<HTMLInputElement>(".always-input");

if (!opacityInput || !opacityValue || !alwaysInput) {
  throw new Error("Settings controls were not found.");
}

const opacityControl = opacityInput;
const opacityReadout = opacityValue;
const alwaysControl = alwaysInput;

function setStatus(value: string): void {
  if (statusEl) {
    statusEl.textContent = value;
  }
}

function normalizeState(value: Partial<WorkspaceState> | null | undefined): WorkspaceState {
  const theme = value?.theme && themes.some((item) => item.key === value.theme) ? value.theme : "workbench";
  const opacity =
    typeof value?.defaultNoteOpacity === "number"
      ? Math.max(35, Math.min(Math.round(value.defaultNoteOpacity), 100))
      : 100;

  return {
    theme,
    defaultNoteOpacity: opacity,
    defaultAlwaysOnTop:
      typeof value?.defaultAlwaysOnTop === "boolean" ? value.defaultAlwaysOnTop : true,
  };
}

function render(): void {
  document.body.dataset.theme = state.theme;

  themeButtons.forEach((button) => {
    const active = button.dataset.theme === state.theme;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  });

  opacityControl.value = String(state.defaultNoteOpacity);
  opacityReadout.textContent = `${state.defaultNoteOpacity}%`;
  alwaysControl.checked = state.defaultAlwaysOnTop;
}

function scheduleSave(): void {
  setStatus("Saving");
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void saveNow();
  }, 160);
}

async function saveNow(): Promise<void> {
  try {
    if (isTauri()) {
      await invoke("save_workspace_state", { state });
      await emit("settings-updated", state);
    } else {
      localStorage.setItem("memstick.workspaceState", JSON.stringify(state));
    }
    setStatus("Saved");
  } catch (error) {
    console.error(error);
    setStatus("Save failed");
  }
}

async function loadState(): Promise<void> {
  try {
    const loaded = isTauri()
      ? await invoke<Partial<WorkspaceState> | null>("load_workspace_state")
      : JSON.parse(localStorage.getItem("memstick.workspaceState") ?? "null");
    state = normalizeState(loaded);
    render();
    setStatus("Ready");
  } catch (error) {
    console.error(error);
    setStatus("Load failed");
  }
}

themeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const theme = button.dataset.theme as ThemeKey | undefined;
    if (!theme || !themes.some((item) => item.key === theme)) {
      return;
    }
    state = { ...state, theme };
    render();
    scheduleSave();
  });
});

opacityControl.addEventListener("input", () => {
  state = {
    ...state,
    defaultNoteOpacity: Math.max(35, Math.min(Number(opacityControl.value), 100)),
  };
  render();
  scheduleSave();
});

alwaysControl.addEventListener("change", () => {
  state = { ...state, defaultAlwaysOnTop: alwaysControl.checked };
  render();
  scheduleSave();
});

render();
void loadState();
