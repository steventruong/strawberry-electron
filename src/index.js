"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const os = require("os");

const { redact, redactString } = require("./redactor");
const diagnostics = require("./diagnostics");
const { Backoff } = require("./backoff");

const DEFAULT_HOST = "https://gotstrawberry.com";
const DEFAULT_FLUSH_INTERVAL = 5000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_QUEUE_SIZE = 10000;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 500;

// IPC channel name for cross-process communication
const IPC_CHANNEL = "strawberry:event";
const IPC_IDENTIFY_CHANNEL = "strawberry:identify";
const IPC_ERROR_CHANNEL = "strawberry:error";

// ---------------------------------------------------------------------------
// Detect which Electron process we are running in
// ---------------------------------------------------------------------------

function detectProcessType() {
  try {
    if (process.type === "browser") return "main";
    if (process.type === "renderer") return "renderer";
  } catch (_) {
    // not in Electron at all
  }
  return "unknown";
}

function getElectronModule(name) {
  try {
    return require("electron")[name] || require("electron");
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core client (runs in main process)
// ---------------------------------------------------------------------------

class StrawberryElectronClient {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.host = (options.host || DEFAULT_HOST).replace(/\/+$/, "");
    this.flushInterval = options.flushInterval || DEFAULT_FLUSH_INTERVAL;
    this.batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
    this.maxQueueSize = options.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE;
    this.appVersion = options.appVersion || null;
    this.releaseVersion = options.releaseVersion || "";
    this.autoCapture = options.autoCapture !== false;

    this._queue = [];
    this._timer = null;
    this._shuttingDown = false;
    this._distinctId = options.distinctId || "anonymous";
    this._processType = detectProcessType();
    this._deviceProps = null;
    this._ipcRegistered = false;
    this._appListeners = [];
    this._windowListeners = new Map();
    this._batchBackoff = new Backoff();
    this._errorBackoff = new Backoff();

    this._startFlushTimer();
    this._registerShutdownHooks();

    if (this._processType === "main" && this.autoCapture) {
      this._setupMainProcessCapture();
    }
  }

  // -----------------------------------------------------------------------
  // Device properties (gathered once, cached)
  // -----------------------------------------------------------------------

  _getDeviceProperties() {
    if (this._deviceProps) return this._deviceProps;

    const props = {
      $os: os.platform(),
      $os_version: os.release(),
      $arch: os.arch(),
      $process_type: this._processType,
    };

    try {
      const electron = require("electron");
      const app = electron.app || electron.remote?.app;
      if (app) {
        props.$app_version = this.appVersion || app.getVersion();
        props.$electron_version = process.versions.electron || "unknown";
        props.$chrome_version = process.versions.chrome || "unknown";
      }
    } catch (_) {
      // Not in Electron context or remote not available
    }

    try {
      const electron = require("electron");
      const screen = electron.screen || electron.remote?.screen;
      if (screen) {
        const primary = screen.getPrimaryDisplay();
        if (primary) {
          props.$screen_width = primary.size.width;
          props.$screen_height = primary.size.height;
          props.$screen_dpr = primary.scaleFactor;
        }
      }
    } catch (_) {
      // screen module may not be available yet
    }

    this._deviceProps = props;
    return props;
  }

  // -----------------------------------------------------------------------
  // Main process auto-capture
  // -----------------------------------------------------------------------

  _setupMainProcessCapture() {
    try {
      const electron = require("electron");
      const { app, autoUpdater, BrowserWindow, ipcMain } = electron;

      if (!app) return;

      // -- App lifecycle events --

      const onReady = () => {
        this._captureInternal("$app_ready", {});
      };
      if (app.isReady()) {
        onReady();
      } else {
        app.on("ready", onReady);
        this._appListeners.push(["ready", onReady]);
      }

      const onWillQuit = () => {
        this._captureInternal("$app_quit", {});
        this._drainQueueSync();
      };
      app.on("will-quit", onWillQuit);
      this._appListeners.push(["will-quit", onWillQuit]);

      // -- Window events --

      const onWindowCreated = (_event, window) => {
        const winId = window.id;
        this._captureInternal("$window_created", { window_id: winId });

        const onClosed = () => {
          this._captureInternal("$window_closed", { window_id: winId });
          this._windowListeners.delete(winId);
        };
        window.on("closed", onClosed);
        this._windowListeners.set(winId, { window, listener: onClosed });
      };
      app.on("browser-window-created", onWindowCreated);
      this._appListeners.push(["browser-window-created", onWindowCreated]);

      // -- Auto-update events --

      if (autoUpdater) {
        try {
          const onUpdateAvailable = () => {
            this._captureInternal("$auto_update_available", {});
          };
          autoUpdater.on("update-available", onUpdateAvailable);

          const onUpdateDownloaded = (_event, releaseNotes, releaseName) => {
            this._captureInternal("$auto_update_downloaded", {
              release_name: releaseName || "unknown",
            });
          };
          autoUpdater.on("update-downloaded", onUpdateDownloaded);
        } catch (_) {
          // autoUpdater may not be available on all platforms (e.g. Linux)
        }
      }

      // -- Crash / render-process-gone events --

      const onUncaughtException = (err) => {
        this._captureInternal("$crash", {
          error_type: "uncaught_exception",
          message: err ? err.message : "unknown",
          stack: err ? err.stack : "",
        });
        this._drainQueueSync();
      };
      process.on("uncaughtException", onUncaughtException);

      const onRenderGone = (_event, _webContents, details) => {
        this._captureInternal("$crash", {
          error_type: "render_process_gone",
          reason: details ? details.reason : "unknown",
          exit_code: details ? details.exitCode : -1,
        });
      };
      app.on("render-process-gone", onRenderGone);
      this._appListeners.push(["render-process-gone", onRenderGone]);

      // -- Deep link / protocol handler --

      const onOpenUrl = (_event, url) => {
        this._captureInternal("$deep_link", { url });
      };
      app.on("open-url", onOpenUrl);
      this._appListeners.push(["open-url", onOpenUrl]);

      // -- IPC bridge (receive events from renderer processes) --

      if (ipcMain && !this._ipcRegistered) {
        this._ipcRegistered = true;

        ipcMain.on(IPC_CHANNEL, (_event, payload) => {
          try {
            const { eventType, properties, distinctId } = payload;
            this.track(eventType, properties, distinctId);
          } catch (_) {
            // never crash
          }
        });

        ipcMain.on(IPC_IDENTIFY_CHANNEL, (_event, payload) => {
          try {
            const { distinctId, properties } = payload;
            this.identify(distinctId, properties);
          } catch (_) {
            // never crash
          }
        });

        ipcMain.on(IPC_ERROR_CHANNEL, (_event, payload) => {
          try {
            const { errorType, message, stack, context } = payload || {};
            // Renderer has already redacted; skip redact here by using raw=true.
            this._sendErrorEnvelope(
              errorType || "Error",
              message || "",
              stack || "",
              context || {},
              {},
              0
            );
            this._captureInternal("$error", {
              $error_type: errorType || "Error",
              $error_message: message || "",
              $error_stack: stack || "",
              ...(context || {}),
            });
          } catch (_) {}
        });
      }
    } catch (err) {
      // If Electron APIs are not available, silently degrade
      console.warn("Strawberry Electron auto-capture setup failed:", err.message);
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  track(eventType, properties, distinctId, raw) {
    try {
      const cleaned = redact(properties || {}, raw === true);
      this._captureInternal(eventType, cleaned, distinctId);
    } catch (_) {
      // Never crash the host application
    }
  }

  identify(distinctId, properties, raw) {
    try {
      if (distinctId) {
        this._distinctId = distinctId;
      }
      const cleaned = redact(properties || {}, raw === true);
      this._captureInternal("$identify", cleaned, distinctId);
    } catch (_) {
      // Never crash
    }
  }

  /**
   * Capture an error. Matches the server-SDK signature:
   *   captureError(error, context = {})
   *
   * POSTs {error_type, message, stack_trace, context, tags, release_version}
   * to /api/v1/errors/ingest with Authorization: Bearer <apiKey>.
   */
  captureError(error, context, raw) {
    try {
      const cleanContext = redact(context || {}, raw === true);
      const message = redactString(
        (error && error.message) || (error ? String(error) : "")
      );
      const stack = redactString((error && error.stack) || "");
      const errorType = (error && error.name) || "Error";

      this._sendErrorEnvelope(errorType, message, stack, cleanContext, {}, 0);

      this._captureInternal("$error", {
        $error_type: errorType,
        $error_message: message,
        $error_stack: stack,
        ...cleanContext,
      });
    } catch (_) {}
  }

  diagnostics() {
    diagnostics.setQueueDepth(this._queue.length);
    return diagnostics.snapshot();
  }

  flush() {
    return this._drainQueue();
  }

  shutdown() {
    this._shuttingDown = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._removeListeners();
    return this._drainQueue();
  }

  // -----------------------------------------------------------------------
  // Preload script helper
  // -----------------------------------------------------------------------

  /**
   * Returns an object suitable for exposing via contextBridge in a preload
   * script. Renderer processes call window.strawberry.track() etc and events
   * are forwarded to the main process over IPC.
   *
   * Usage in preload.js:
   *   const { contextBridge } = require('electron');
   *   const { Strawberry } = require('strawberry-electron');
   *   contextBridge.exposeInMainWorld('strawberry', Strawberry.preloadBridge());
   */
  static preloadBridge() {
    let ipcRenderer;
    try {
      ipcRenderer = require("electron").ipcRenderer;
    } catch (_) {
      // fallback: noop bridge
      return {
        track: () => {},
        identify: () => {},
      };
    }

    return {
      track: (eventType, properties, raw) => {
        // Redact in the renderer before crossing the IPC boundary so raw
        // PII never reaches the main process.
        const cleaned = redact(properties || {}, raw === true);
        ipcRenderer.send(IPC_CHANNEL, { eventType, properties: cleaned });
      },
      identify: (distinctId, properties, raw) => {
        const cleaned = redact(properties || {}, raw === true);
        ipcRenderer.send(IPC_IDENTIFY_CHANNEL, { distinctId, properties: cleaned });
      },
      captureError: (error, context, raw) => {
        const cleanContext = redact(context || {}, raw === true);
        const message = redactString(
          (error && error.message) || (error ? String(error) : "")
        );
        const stack = redactString((error && error.stack) || "");
        const errorType = (error && error.name) || "Error";
        ipcRenderer.send(IPC_ERROR_CHANNEL, {
          errorType, message, stack, context: cleanContext,
        });
      },
    };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  _captureInternal(eventType, properties, distinctId) {
    const did = distinctId || this._distinctId || "anonymous";
    const deviceProps = this._getDeviceProperties();

    const event = {
      event_type: eventType,
      properties: { ...deviceProps, ...properties },
      timestamp: new Date().toISOString(),
      distinct_id: did,
      uuid: crypto.randomUUID(),
    };
    if (this.releaseVersion) {
      event.release_version = this.releaseVersion;
    }

    if (this._queue.length >= this.maxQueueSize) {
      diagnostics.recordDrop();
      console.warn(
        `Strawberry event queue full (${this.maxQueueSize} events). Dropping event: ${eventType}`
      );
      return;
    }

    this._queue.push(event);
    diagnostics.setQueueDepth(this._queue.length);
  }

  _removeListeners() {
    try {
      const electron = require("electron");
      const { app } = electron;
      if (app) {
        for (const [event, listener] of this._appListeners) {
          app.removeListener(event, listener);
        }
      }
    } catch (_) {}
    this._appListeners = [];
    this._windowListeners.clear();
  }

  _startFlushTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this._drainQueue();
    }, this.flushInterval);
    if (this._timer.unref) {
      this._timer.unref();
    }
  }

  _registerShutdownHooks() {
    this._exitHandler = () => {
      this._drainQueueSync();
    };
    this._beforeExitHandler = () => {
      this._drainQueue();
    };
    try {
      process.on("exit", this._exitHandler);
      process.on("beforeExit", this._beforeExitHandler);
    } catch (_) {}
  }

  async _drainQueue() {
    while (this._queue.length > 0) {
      const batch = this._queue.splice(0, this.batchSize);
      if (batch.length > 0) {
        await this._sendBatch(batch);
      }
    }
  }

  _drainQueueSync() {
    while (this._queue.length > 0) {
      const batch = this._queue.splice(0, this.batchSize);
      if (batch.length > 0) {
        this._sendBatchSync(batch);
      }
    }
  }

  _sendBatch(events) {
    return new Promise((resolve) => {
      this._sendWithRetry(events, 0, resolve);
    });
  }

  _sendWithRetry(events, attempt, done) {
    try {
      const payload = JSON.stringify({
        api_key: this.apiKey,
        events,
      });

      const url = new URL(`${this.host}/api/v1/ingest`);
      const isHttps = url.protocol === "https:";
      const transport = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "User-Agent": "StrawberrySDK-Electron/1.0.0",
          Authorization: `Bearer ${this.apiKey}`,
        },
        timeout: 10000,
      };

      const req = transport.request(options, (res) => {
        res.resume();
        res.on("end", () => {
          if (res.statusCode >= 500 && attempt < MAX_RETRIES - 1) {
            diagnostics.recordRetry();
            const delay = this._batchBackoff.nextMs();
            setTimeout(() => {
              this._sendWithRetry(events, attempt + 1, done);
            }, delay);
            return;
          }
          if (res.statusCode >= 400) {
            diagnostics.recordFailure();
          } else {
            this._batchBackoff.reset();
          }
          done();
        });
      });

      req.on("error", (err) => {
        if (attempt < MAX_RETRIES - 1) {
          diagnostics.recordRetry();
          const delay = this._batchBackoff.nextMs();
          console.warn(
            `Strawberry send failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delay}ms`
          );
          setTimeout(() => {
            this._sendWithRetry(events, attempt + 1, done);
          }, delay);
        } else {
          diagnostics.recordFailure();
          console.error(
            `Strawberry send failed after ${MAX_RETRIES} attempts, dropping ${events.length} events`
          );
          done();
        }
      });

      req.on("timeout", () => {
        req.destroy(new Error("Request timeout"));
      });

      req.write(payload);
      req.end();
    } catch (err) {
      diagnostics.recordFailure();
      console.error(`Strawberry send error: ${err.message}`);
      done();
    }
  }

  /**
   * POST an error to /api/v1/errors/ingest using the server-SDK envelope.
   */
  _sendErrorEnvelope(errorType, message, stackTrace, context, tags, attempt) {
    try {
      const body = {
        error_type: errorType,
        message,
        stack_trace: stackTrace,
        context,
        tags,
        distinct_id: this._distinctId || "anonymous",
        timestamp: new Date().toISOString(),
      };
      if (this.releaseVersion) {
        body.release_version = this.releaseVersion;
      }

      const payload = JSON.stringify(body);
      const url = new URL(`${this.host}/api/v1/errors/ingest`);
      const isHttps = url.protocol === "https:";
      const transport = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "User-Agent": "StrawberrySDK-Electron/1.0.0",
          Authorization: `Bearer ${this.apiKey}`,
        },
        timeout: 10000,
      };

      const req = transport.request(options, (res) => {
        res.resume();
        res.on("end", () => {
          if (res.statusCode >= 500 && attempt < MAX_RETRIES - 1) {
            diagnostics.recordRetry();
            const delay = this._errorBackoff.nextMs();
            setTimeout(() => {
              this._sendErrorEnvelope(
                errorType, message, stackTrace, context, tags, attempt + 1
              );
            }, delay);
            return;
          }
          if (res.statusCode >= 400) {
            diagnostics.recordFailure();
          } else {
            this._errorBackoff.reset();
          }
        });
      });

      req.on("error", () => {
        if (attempt < MAX_RETRIES - 1) {
          diagnostics.recordRetry();
          const delay = this._errorBackoff.nextMs();
          setTimeout(() => {
            this._sendErrorEnvelope(
              errorType, message, stackTrace, context, tags, attempt + 1
            );
          }, delay);
        } else {
          diagnostics.recordFailure();
        }
      });

      req.on("timeout", () => {
        req.destroy(new Error("Request timeout"));
      });

      req.write(payload);
      req.end();
    } catch (_) {
      diagnostics.recordFailure();
    }
  }

  _sendBatchSync(events) {
    try {
      const payload = JSON.stringify({
        api_key: this.apiKey,
        events,
      });

      const url = new URL(`${this.host}/api/v1/ingest`);
      const isHttps = url.protocol === "https:";
      const transport = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "User-Agent": "StrawberrySDK-Electron/1.0.0",
          Authorization: `Bearer ${this.apiKey}`,
        },
        timeout: 5000,
      };

      const req = transport.request(options);
      req.on("error", () => {});
      req.write(payload);
      req.end();
    } catch (_) {
      // Best effort on exit
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton API
// ---------------------------------------------------------------------------

let _instance = null;

const Strawberry = {
  /**
   * Initialize the SDK. Call this once in your main process entry point.
   *
   *   const { Strawberry } = require('strawberry-electron');
   *   Strawberry.configure({ apiKey: 'sbk_...', host: 'https://straw.berryagents.com' });
   */
  configure(options = {}) {
    if (_instance) {
      try { _instance.shutdown(); } catch (_) {}
    }
    const apiKey = options.apiKey;
    if (!apiKey) {
      throw new Error("Strawberry.configure() requires an apiKey");
    }
    _instance = new StrawberryElectronClient(apiKey, options);
    return _instance;
  },

  /**
   * Track a custom event.
   *   Strawberry.track('$file_opened', { path: '/doc.pdf' });
   */
  track(eventType, properties) {
    if (!_instance) {
      console.warn("Strawberry not configured. Call Strawberry.configure() first.");
      return;
    }
    _instance.track(eventType, properties);
  },

  /**
   * Identify a user across sessions.
   *   Strawberry.identify('user_123', { email: 'user@example.com' });
   */
  identify(distinctId, properties) {
    if (!_instance) {
      console.warn("Strawberry not configured. Call Strawberry.configure() first.");
      return;
    }
    _instance.identify(distinctId, properties);
  },

  /**
   * Capture an error.
   *   Strawberry.captureError(err, { user_id: '...' });
   */
  captureError(error, context, raw) {
    if (!_instance) {
      console.warn("Strawberry not configured. Call Strawberry.configure() first.");
      return;
    }
    _instance.captureError(error, context, raw);
  },

  /**
   * Diagnostics snapshot: queue depth, drops, retries, failures,
   * breaker state, redaction count.
   */
  diagnostics() {
    if (!_instance) {
      return {
        queue_depth: 0,
        drops: 0,
        retries: 0,
        failures: 0,
        breaker_state: "CLOSED",
        redaction_count: 0,
      };
    }
    return _instance.diagnostics();
  },

  /**
   * Flush all queued events immediately.
   */
  flush() {
    if (_instance) return _instance.flush();
    return Promise.resolve();
  },

  /**
   * Shut down the SDK, flushing remaining events.
   */
  shutdown() {
    if (_instance) {
      const p = _instance.shutdown();
      _instance = null;
      return p;
    }
    return Promise.resolve();
  },

  /**
   * Returns an object for use with contextBridge.exposeInMainWorld() in a
   * preload script, allowing renderer processes to send events to the main
   * process over IPC.
   */
  preloadBridge() {
    return StrawberryElectronClient.preloadBridge();
  },
};

module.exports = { Strawberry, StrawberryElectronClient };
