import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const binaryName = process.platform === "win32" ? "memstick.exe" : "memstick";
const appBinary = path.join(projectDir, "src-tauri", "target", "debug", binaryName);

let tauriDriver;
let isShuttingDown = false;

export const config = {
  host: "127.0.0.1",
  port: 4444,
  specs: [path.join(projectDir, "e2e", "specs", "**", "*.e2e.js")],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      "tauri:options": {
        application: appBinary,
      },
    },
  ],
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },
  onPrepare() {
    if (!process.env.WDIO_SKIP_BUILD) {
      const result = spawnSync("pnpm", ["tauri", "build", "--debug", "--no-bundle"], {
        cwd: projectDir,
        shell: true,
        stdio: "inherit",
      });

      if (result.status !== 0) {
        throw new Error("Failed to build the Tauri debug binary for E2E.");
      }
    }

    if (!fs.existsSync(appBinary)) {
      throw new Error(`Tauri debug binary was not found: ${appBinary}`);
    }
  },
  beforeSession() {
    const driverPath = findExecutable("tauri-driver");
    if (!driverPath) {
      throw new Error("tauri-driver was not found. Run `pnpm e2e:install-tauri-driver`.");
    }

    const nativeDriverPath = findExecutable("msedgedriver");
    if (process.platform === "win32" && !nativeDriverPath) {
      throw new Error("msedgedriver.exe was not found. Install the matching Edge driver first.");
    }

    const args = nativeDriverPath ? ["--native-driver", nativeDriverPath] : [];
    tauriDriver = spawn(driverPath, args, {
      stdio: ["ignore", process.stdout, process.stderr],
    });

    tauriDriver.on("error", (error) => {
      console.error("tauri-driver error:", error);
      process.exit(1);
    });
    tauriDriver.on("exit", (code) => {
      if (!isShuttingDown) {
        console.error("tauri-driver exited with code:", code);
        process.exit(1);
      }
    });
  },
  afterSession() {
    closeTauriDriver();
  },
};

function closeTauriDriver() {
  isShuttingDown = true;
  tauriDriver?.kill();
}

function findExecutable(name) {
  const executable = process.platform === "win32" && !name.endsWith(".exe") ? `${name}.exe` : name;
  const candidates = [
    process.env.TAURI_DRIVER,
    path.join(projectDir, executable),
    path.join(os.homedir(), ".cargo", "bin", executable),
    ...process.env.PATH.split(path.delimiter).map((entry) => path.join(entry, executable)),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate));
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(signal, () => {
    closeTauriDriver();
    process.exit();
  });
}
