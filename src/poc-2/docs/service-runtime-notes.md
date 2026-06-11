# Service Runtime Notes

This POC treats "Windows service-style" as a tray-resident desktop utility:
it starts with the user session, keeps a native process alive in the tray, hides
the settings window instead of exiting on close, and reacts to a global shortcut.

It is not a Windows Service Control Manager service. That distinction matters
because a Tauri app owns a user-facing WebView, tray icon, and per-user startup
registration.

## Runtime Behaviors

- Autostart: `tauri-plugin-autostart` registers the app to launch at login.
- Tray: Tauri's `tray-icon` feature creates a persistent tray entry with open,
  hide, and quit actions.
- Global shortcut: `tauri-plugin-global-shortcut` registers
  `CommandOrControl+Shift+Space`.
- Window lifecycle: closing the settings window hides it and keeps the process
  running; quitting must happen from the tray menu.

## Verification Checklist

1. Run `pnpm tauri dev`.
2. Confirm the tray icon appears.
3. Close the settings window and confirm the process remains alive.
4. Use the tray menu to reopen the settings window.
5. Press `Ctrl+Shift+Space` on Windows and confirm the trigger counter/log
   updates.
6. Toggle autostart in the settings window and confirm the reported state
   changes.

## Open Questions For The Next POC

- Whether the trigger should open a compact command palette instead of the full
  settings window.
- Whether global shortcut configuration needs conflict detection and remapping.
- Whether startup should be delayed until the desktop shell is fully ready.
- Whether production needs a watchdog helper or single-instance plugin.
