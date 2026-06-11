import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import {
  isRegistered,
  register,
  unregister,
} from "@tauri-apps/plugin-global-shortcut";
import "./styles.css";

type TriggerEvent = {
  shortcut: string;
  state: string;
  sequence: number;
};

type ServiceState = {
  autostart: boolean;
  shortcutRegistered: boolean;
  nativeReady: boolean;
  shortcut: string;
  lastTriggerAt: string | null;
  triggerCount: number;
};

const fallbackShortcut = "CommandOrControl+Shift+Space";

let state: ServiceState = {
  autostart: false,
  shortcutRegistered: false,
  nativeReady: isTauri(),
  shortcut: fallbackShortcut,
  lastTriggerAt: null,
  triggerCount: 0,
};

const app = document.querySelector<HTMLDivElement>("#app");

if (app) {
  app.innerHTML = `
    <main class="app-shell">
      <section class="settings-surface" aria-label="Memstick settings">
        <header class="topbar">
          <div class="brand-lockup">
            <div class="brand-mark" aria-hidden="true">M</div>
            <div>
              <p class="eyebrow">Memstick POC 2</p>
              <h1>백그라운드 앱</h1>
            </div>
          </div>
          <div class="rail-status">
            <span class="pulse" aria-hidden="true"></span>
            <span id="runtime-label">Checking native runtime</span>
          </div>
        </header>

        <nav class="quick-tabs" aria-label="Settings sections">
          <a href="#service">상태</a>
          <a href="#startup">자동 실행</a>
          <a href="#shortcut">단축키</a>
          <a href="#tray">트레이</a>
          <a href="#diagnostics">기록</a>
        </nav>

        <header class="settings-header" id="service">
          <div>
            <p class="eyebrow">Memstick helper</p>
            <h2>백그라운드 설정</h2>
        </div>
        <div class="header-actions">
            <button class="ghost-button" id="hide-window" type="button">트레이로 숨기기</button>
            <button class="primary-button" id="refresh-state" type="button">상태 새로고침</button>
          </div>
        </header>

        <section class="status-strip" aria-label="Current service state">
          <article class="status-tile">
            <span class="tile-label">실행 환경</span>
            <strong id="native-status">Browser preview</strong>
            <small>Native</small>
          </article>
          <article class="status-tile">
            <span class="tile-label">자동 실행</span>
            <strong id="autostart-status">Unknown</strong>
            <small>Login</small>
          </article>
          <article class="status-tile">
            <span class="tile-label">단축키</span>
            <strong id="shortcut-status">Unregistered</strong>
            <small id="shortcut-value">${fallbackShortcut}</small>
          </article>
          <article class="status-tile accent">
            <span class="tile-label">반응 횟수</span>
            <strong id="trigger-count">0</strong>
            <small id="last-trigger">-</small>
          </article>
        </section>

        <section class="settings-list">
          <article class="setting-panel" id="startup">
            <div class="panel-heading">
              <div>
                <p class="eyebrow">처음 켤 때</p>
                <h3>Windows 시작 시 자동 실행</h3>
              </div>
              <label class="switch">
                <input id="autostart-toggle" type="checkbox" />
                <span></span>
              </label>
            </div>
            <div class="setting-list">
              <label>
                <span>숨김 시작</span>
                <input type="checkbox" checked />
              </label>
              <label>
                <span>복구</span>
                <input type="checkbox" />
              </label>
              <label>
                <span>알림</span>
                <input type="checkbox" checked />
              </label>
            </div>
          </article>

          <article class="setting-panel feature-panel" id="shortcut">
            <div class="panel-heading">
              <div>
                <p class="eyebrow">빠른 호출</p>
                <h3>어디서든 누르는 단축키</h3>
              </div>
              <span class="state-pill" id="shortcut-pill">waiting</span>
            </div>
            <div class="shortcut-recorder" aria-label="Configured shortcut">
              <kbd>Ctrl</kbd>
              <kbd>Shift</kbd>
              <kbd>Space</kbd>
            </div>
            <div class="button-row">
              <button class="secondary-button" id="register-shortcut" type="button">단축키 켜기</button>
              <button class="ghost-button" id="unregister-shortcut" type="button">단축키 끄기</button>
            </div>
          </article>

          <article class="setting-panel" id="tray">
            <div class="panel-heading">
              <div>
                <p class="eyebrow">작게 숨어 있기</p>
                <h3>트레이에서 계속 대기</h3>
              </div>
              <span class="state-pill good">tray-first</span>
            </div>
            <div class="tray-map">
              <div>
                <strong>닫기 버튼</strong>
              </div>
              <div>
                <strong>설정 열기</strong>
              </div>
              <div>
                <strong>설정 숨기기</strong>
              </div>
              <div>
                <strong>앱 종료</strong>
              </div>
            </div>
          </article>

          <article class="setting-panel" id="diagnostics">
            <div class="panel-heading">
              <div>
                <p class="eyebrow">방금 무슨 일이 있었지?</p>
                <h3>단축키 기록</h3>
              </div>
              <button class="ghost-button compact" id="clear-log" type="button">비우기</button>
            </div>
            <ol class="event-log" id="event-log">
              <li>아직 단축키 반응이 없어요.</li>
            </ol>
          </article>
        </section>
      </section>
    </main>
  `;

  bindControls();
  void boot();
}

function bindControls(): void {
  document.querySelector("#refresh-state")?.addEventListener("click", () => {
    void refreshState();
  });

  document.querySelector("#hide-window")?.addEventListener("click", async () => {
    if (state.nativeReady) {
      await getCurrentWindow().hide();
    }
  });

  document.querySelector("#autostart-toggle")?.addEventListener("change", async (event) => {
    const checked = event.target instanceof HTMLInputElement && event.target.checked;
    if (!state.nativeReady) {
      updateLog("자동 실행은 데스크톱 앱에서만 확인할 수 있어요.");
      render();
      return;
    }

    checked ? await enable() : await disable();
    await refreshState();
  });

  document.querySelector("#register-shortcut")?.addEventListener("click", async () => {
    if (!state.nativeReady) {
      updateLog("단축키 등록은 데스크톱 앱에서만 가능해요.");
      return;
    }
    await registerShortcut();
  });

  document.querySelector("#unregister-shortcut")?.addEventListener("click", async () => {
    if (!state.nativeReady) {
      updateLog("단축키 해제는 데스크톱 앱에서만 가능해요.");
      return;
    }
    await unregister(state.shortcut);
    await refreshState();
    updateLog(`${state.shortcut} unregistered.`);
  });

  document.querySelector("#clear-log")?.addEventListener("click", () => {
    const log = document.querySelector<HTMLOListElement>("#event-log");
    if (log) {
      log.innerHTML = "<li>아직 단축키 반응이 없어요.</li>";
    }
  });
}

async function boot(): Promise<void> {
  if (state.nativeReady) {
    state.shortcut = await invoke<string>("default_shortcut");
    await listen<TriggerEvent>("shortcut-triggered", (event) => {
      state.triggerCount = event.payload.sequence;
      state.lastTriggerAt = new Date().toLocaleTimeString();
      updateLog(`${event.payload.shortcut} ${event.payload.state}`);
      render();
    });
  }

  await refreshState();
}

async function refreshState(): Promise<void> {
  if (state.nativeReady) {
    state.autostart = await isEnabled();
    state.shortcutRegistered = await isRegistered(state.shortcut);
  }

  render();
}

async function registerShortcut(): Promise<void> {
  if (await isRegistered(state.shortcut)) {
    updateLog(`${state.shortcut} is already registered.`);
    await refreshState();
    return;
  }

  await register(state.shortcut, (event) => {
    if (event.state !== "Pressed") {
      return;
    }
    state.triggerCount += 1;
    state.lastTriggerAt = new Date().toLocaleTimeString();
    updateLog(`${state.shortcut} pressed from JavaScript handler.`);
    render();
  });
  await refreshState();
  updateLog(`${state.shortcut} registered from settings.`);
}

function render(): void {
  setText("#runtime-label", state.nativeReady ? "데스크톱 앱으로 실행 중" : "브라우저 미리보기");
  setText("#native-status", state.nativeReady ? "데스크톱 앱" : "미리보기");
  setText("#autostart-status", state.autostart ? "켜짐" : "꺼짐");
  setText("#shortcut-status", state.shortcutRegistered ? "준비됨" : "대기 중");
  setText("#shortcut-value", state.shortcut);
  setText("#trigger-count", String(state.triggerCount));
  setText("#last-trigger", state.lastTriggerAt ?? "-");
  setText("#shortcut-pill", state.shortcutRegistered ? "준비 완료" : "대기 중");

  document.querySelector("#runtime-label")?.classList.toggle("muted", !state.nativeReady);
  document.querySelector("#shortcut-pill")?.classList.toggle("good", state.shortcutRegistered);

  const autostartToggle = document.querySelector<HTMLInputElement>("#autostart-toggle");
  if (autostartToggle) {
    autostartToggle.checked = state.autostart;
    autostartToggle.disabled = !state.nativeReady;
  }
}

function updateLog(message: string): void {
  const log = document.querySelector<HTMLOListElement>("#event-log");
  if (!log) {
    return;
  }

  const first = log.querySelector("li");
  if (first?.textContent === "아직 단축키 반응이 없어요.") {
    log.innerHTML = "";
  }

  const item = document.createElement("li");
  item.innerHTML = `<time>${new Date().toLocaleTimeString()}</time><span>${escapeHtml(message)}</span>`;
  log.prepend(item);
}

function setText(selector: string, value: string): void {
  const element = document.querySelector(selector);
  if (element) {
    element.textContent = value;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
