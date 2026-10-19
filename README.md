# aiextension — AppAI Browser Debug (Chrome MV3)

Lets the `appai` coding agent debug pages in **tabs it opens itself** (purple "AppAI" tab group), using your real logged-in session.

## Install
1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this folder.
2. Copy the extension id shown on the card.
3. `appai browser pair <extension-id>` (writes the native messaging host manifest; restart Chrome or reload the extension).
4. `appai chat`, then ask the agent to debug a page (needs the `CODE_AGENT_BROWSER_TOOLS` flag on the server).

`appai browser status` shows pairing and whether a session holds the bridge. Only one `appai` session can own the bridge at a time.

## How it works
`appai` ⇄ unix socket (`~/.appai/browser/bridge.sock`, 0600) ⇄ native host (`appai browser-host`, started by Chrome) ⇄ this extension ⇄ `chrome.debugger` (CDP). Design: `aispecs/code-agent/browser-debug-spec.md`.

## Safety
- Only tabs in the agent's tab group can be controlled; your other tabs are invisible to it.
- Admin `blocked_origins` are re-checked here before and after every command; blocked pages are navigated to `about:blank`.
- No cookie/storage access, no file upload, headers are never captured; Chrome shows its "debugging this browser" banner while attached.
