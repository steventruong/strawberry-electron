# Strawberry Electron SDK

Analytics SDK for Electron desktop apps. Captures main process lifecycle events, auto-update status, crash reports, deep links, and custom events from both main and renderer processes.

## Installation

```bash
npm install github:steventruong/strawberry-electron#v1.0.0
```

Requires `electron >= 20`.

## Quick Start (Main Process)

```javascript
const { Strawberry } = require('strawberry-electron');

Strawberry.configure({
  apiKey: 'berry_your_api_key',
  host: 'https://straw.berryagents.com',
});

// Custom events
Strawberry.track('$file_opened', { path: '/doc.pdf' });
Strawberry.identify('user_123', { email: 'user@example.com' });
```

## Renderer Process (via Preload)

In your preload script:

```javascript
const { contextBridge } = require('electron');
const { Strawberry } = require('strawberry-electron');

contextBridge.exposeInMainWorld('strawberry', Strawberry.preloadBridge());
```

Then in your renderer code:

```javascript
window.strawberry.track('$button_clicked', { button: 'export' });
window.strawberry.identify('user_456');
```

## Auto-Captured Events

The SDK automatically captures these events when running in the main process:

| Event | Description |
|-------|-------------|
| `$app_ready` | `app.on('ready')` fired |
| `$app_quit` | `app.on('will-quit')` fired |
| `$window_created` | New BrowserWindow created |
| `$window_closed` | BrowserWindow closed |
| `$auto_update_available` | An update is available |
| `$auto_update_downloaded` | Update downloaded and ready to install |
| `$crash` | Uncaught exception or render process gone |
| `$deep_link` | Protocol handler URL opened |

## Device Properties

Every event includes these device properties automatically:

- `$os` - Operating system (darwin, win32, linux)
- `$os_version` - OS release version
- `$arch` - CPU architecture (x64, arm64)
- `$electron_version` - Electron version
- `$chrome_version` - Chromium version
- `$app_version` - Your app version
- `$screen_width`, `$screen_height`, `$screen_dpr` - Display info
- `$process_type` - main or renderer

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `apiKey` | (required) | Your Strawberry API key |
| `host` | `https://gotstrawberry.com` | Strawberry server URL |
| `flushInterval` | `5000` | Flush interval in ms |
| `batchSize` | `50` | Max events per batch |
| `maxQueueSize` | `10000` | Max queued events before dropping |
| `appVersion` | auto-detected | Override app version string |
| `autoCapture` | `true` | Auto-capture main process events |
| `distinctId` | `anonymous` | Default distinct ID |

## Dependencies

None. Uses only Node.js built-in modules and Electron APIs.
