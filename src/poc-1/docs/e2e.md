# Desktop E2E

Memstick uses Tauri WebDriver tests for flows that need the real desktop app,
native IPC, and local filesystem behavior.

## Prerequisites

Install the Tauri WebDriver wrapper:

```bash
pnpm e2e:install-tauri-driver
```

On Windows, `tauri-driver` also needs `msedgedriver.exe` on `PATH`. The Edge
driver version must match the installed Microsoft Edge version. The E2E config
also checks for a local `./msedgedriver.exe`, which is useful when the driver is
downloaded into the project directory during local setup.

## Run

```bash
pnpm install
pnpm e2e
```

The E2E runner builds a debug Tauri binary with:

```bash
pnpm tauri build --debug --no-bundle
```

Then it launches the app through `tauri-driver` and runs WebdriverIO specs.

To reuse an already-built binary while developing tests:

```bash
$env:WDIO_SKIP_BUILD = "1"
pnpm e2e
```

## Current Coverage

- The real Tauri window boots and renders the editor.
- The local image asset policy runs through real Tauri IPC:
  - an external image is copied into `docs/assets/`,
  - the Markdown path is returned relative to the document,
  - the copied test asset is removed after the assertion.

Browser-only tests can still cover detailed editor keyboard behavior. Desktop
E2E should stay focused on flows that actually require Tauri, IPC, native file
access, or app packaging.
