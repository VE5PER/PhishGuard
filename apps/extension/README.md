# PhishGuard Browser Extension (`apps/extension`) 🛡️

Manifest V3 browser extension providing real-time, privacy-preserving behavioral fraud and phishing detection directly on-device.

---

## 🏛️ Architecture Overview

The extension operates across three synchronized execution contexts:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Inspected Tab / DOM Context                     │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ src/content/telemetry-collector.ts                               │  │
│  │  - Pointer kinematics: (x, y, dx, dy, v, a, θ) @ rAF             │  │
│  │  - Keystroke dynamics: dwell & flight times (zero raw chars)      │  │
│  │  - DOM topology: opacity:0 traps, iframe crossings, credential  │  │
│  │    solicitation zones                                            │  │
│  │  - On-screen phishing blocking overlay & alert banner            │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ chrome.runtime.sendMessage
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   Background Service Worker Context                    │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ src/background/service-worker.ts                                 │  │
│  │  - Onnxruntime-web session (WebGPU / WASM INT8 Student Model)    │  │
│  │  - Tri-State Decision Router:                                    │  │
│  │      • Score < 0.15          ──► SAFE (Silent)                   │  │
│  │      • 0.15 <= Score <= 0.85 ──► AMBIGUOUS (POST /v1/escalate)   │  │
│  │      • Score > 0.85          ──► BLOCK (Render warning overlay)  │  │
│  │  - Reputation cache check & offline fallback                     │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────▲────────────────────────────────────┘
                                    │ chrome.runtime.connect
┌───────────────────────────────────┴────────────────────────────────────┐
│                    Toolbar Popup & Threat Inspector                    │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ popup/popup.html + popup/popup.ts                                │  │
│  │  - Real-time threat gauge, risk score, & classification badges   │  │
│  │  - Kinematic & DOM metrics breakdown (trajectory points, dwell)  │  │
│  │  - Live server connection status & cloud escalation logs         │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Building & Loading

### 1. Build the Extension Bundle
```bash
# Build extension into dist/
pnpm --filter @phishguard/extension build

# Type check
pnpm --filter @phishguard/extension typecheck

# Unit tests
pnpm --filter @phishguard/extension test
```

### 2. Load Unpacked in Chrome
1. Navigate to `chrome://extensions/` in Chrome.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the `apps/extension` folder.
4. The extension icon will appear in your browser toolbar with ID `loanjnnlfhechkonbjelmbdacmmcbagg`.

---

## 🔍 Debugging with Chrome DevTools MCP

You can inspect, interact with, and automate testing of the running PhishGuard extension using the official [Chrome DevTools MCP server](https://github.com/ChromeDevTools/chrome-devtools-mcp). This connects AI agents (such as Antigravity, Claude, or Cursor) directly to your active browser session.

### Step 1: Enable Remote Debugging in Chrome

For `chrome-devtools-mcp` to connect to Chrome, remote debugging must be enabled using either method below:

#### Option A: Dynamic Toggle (Chrome 144+ — No restart needed)
1. In your running Chrome browser, open:
   ```text
   chrome://inspect/#remote-debugging
   ```
2. Enable the **Remote debugging** toggle.
3. Chrome will instantly open its DevTools debugging socket and generate `DevToolsActivePort`.

#### Option B: Launch Chrome with Remote Debugging Port
Close any running instances of Chrome or launch with an isolated debugging profile:

**Linux:**
```bash
google-chrome --remote-debugging-port=9222 --load-extension="$(pwd)/apps/extension"
```

**macOS:**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --load-extension="$(pwd)/apps/extension"
```

**Windows (PowerShell):**
```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --load-extension="$PWD/apps/extension"
```

*(Tip: To launch side-by-side with your daily Chrome without closing open windows, append `--user-data-dir=/tmp/phishguard-chrome-dev`)*.

---

### Step 2: Configure the MCP Server

#### In Google Antigravity
Add `chrome-devtools` to `~/.gemini/config/mcp_config.json`:
```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@latest",
        "--auto-connect"
      ]
    }
  }
}
```
*If connecting to a specific debugging port (e.g. `9222`), replace `"--auto-connect"` with `"--browserUrl=http://127.0.0.1:9222"`.*

#### In Claude Desktop
Add to `~/.config/Claude/claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--auto-connect"]
    }
  }
}
```

#### In Cursor (`.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--browserUrl=http://127.0.0.1:9222"]
    }
  }
}
```

---

### Step 3: Available DevTools MCP Debugging Capabilities

Once connected, you (or your AI assistant) can invoke these DevTools tools directly:

| Tool | Purpose in PhishGuard Extension |
| :--- | :--- |
| `list_pages` | Lists all active tabs and extension views currently open. |
| `select_page` | Switches focus to a target web page or extension popup. |
| `list_console_messages` | Reads live browser console output, including telemetry capture events, on-device model inference scores, and background worker messages. |
| `get_console_message` | Retrieves detailed error stack traces if on-device ONNX inference fails. |
| `list_network_requests` | Monitors outgoing network escalations dispatched to `POST /v1/escalate` and checks latency & status codes. |
| `get_network_request` | Inspects full `EscalationPayload` JSON structures sent to the FastAPI gateway. |
| `evaluate_script` | Executes JavaScript inside the page context (e.g. triggers synthetic mouse bursts or inspects `window.__phishguard` states). |
| `take_screenshot` | Captures screenshots of the blocked overlay, popup UI, or simulated phishing page. |
| `take_heapsnapshot` | Validates memory consumption against the extension's **~200 MiB peak RSS soft target / 512 MiB hard ceiling**. |
| `performance_start_trace` / `performance_stop_trace` | Profiles on-device INT8 student model inference latency (ensuring **< 40 ms** target). |

---

### Step 4: Quick Debugging Recipes

#### 1. Inspect Background Service Worker
1. Open `chrome://extensions/` in Chrome.
2. Find **PhishGuard**.
3. Click the link next to **Inspect views: service worker** to open a dedicated DevTools window.
4. Verify the model initialization log:
   ```text
   [PhishGuard] Initializing on-device ONNX student model session...
   [PhishGuard] Execution provider: wasm / webgpu initialized in 32ms.
   ```

#### 2. Verify Content Script Telemetry Collection
1. Open any web page (e.g. `http://localhost:8000/`).
2. Open DevTools (`F12`) &rarr; **Console**.
3. Move your mouse or type into a test field. Verify that pointer velocities and keystroke dwell/flight times are calculated without recording raw character strings.

#### 3. Test Phishing Block Trigger
In the page DevTools console or via MCP `evaluate_script`:
```javascript
// Dispatch a synthetic ambiguous/block interaction payload to background
chrome.runtime.sendMessage({
  type: "EVALUATE_INTERACTION",
  payload: {
    url: window.location.href,
    syntheticRiskScore: 0.92
  }
});
```
Observe the immediate client-side block overlay inserted by `src/content/telemetry-collector.ts`.

---

## 🔒 Privacy & Compliance Constraints

- **GDPR / PCI-DSS:** Never log, print, or transmit raw keyboard input values.
- **Strict Typing:** All data structures must comply with `@phishguard/types`.
- **Memory Cap:** Soft target of ~200 MiB peak RSS for the worker process (reported/warned, not enforced); hard sanity ceiling **512 MiB**.
