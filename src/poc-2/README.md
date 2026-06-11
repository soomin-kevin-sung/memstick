# Memstick POC 2

Windows service-style Tauri v2 POC for startup launch, tray residency, and
global shortcut trigger verification.

## Development

```powershell
pnpm install
pnpm dev
pnpm tauri dev
```

The browser preview runs on `http://127.0.0.1:1430/`. Native autostart, tray,
and global shortcut APIs require `pnpm tauri dev`.

See [`docs/service-runtime-notes.md`](docs/service-runtime-notes.md) for the
service-style runtime model and verification checklist.
