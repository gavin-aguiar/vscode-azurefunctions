# Debugging Go Azure Functions

This guide explains how to debug Go (Golang) Azure Functions locally using the VS Code extension.

## Prerequisites

1. **Go 1.24+** — [go.dev/dl](https://go.dev/dl/)
2. **Delve debugger** — Install with:
   ```bash
   go install github.com/go-delve/delve/cmd/dlv@latest
   ```
   Make sure `$GOPATH/bin` (or `%GOPATH%\bin` on Windows) is in your PATH.
3. **Azure Functions Core Tools with Go worker support** — Install with:
   ```bash
   npm i -g @gaaguiar/azure-functions-core-tools
   ```
4. **VS Code Go extension** (`golang.go`) — Install from the VS Code Marketplace

## Project Setup

Your Go function project must have a valid Go module. If not already initialized:

```bash
cd your-function-app
go mod init your-module-name
go get github.com/AzureAD/azure-sdk-for-go/...   # or whatever dependencies you need
go mod tidy
```

## How Debugging Works

Press **F5** — everything is automatic. The extension uses a **remote attach** flow:

1. **F5** triggers the `func: host start` pre-launch task
2. `func host start` builds your Go worker binary (`app.exe` / `app`) and starts the Functions host
3. The extension automatically polls for the `app` process in the background
4. Once `app` is detected, the extension spawns `dlv attach --continue` in headless mode on port 2345
5. The VS Code Go extension connects to the Delve DAP server
6. Breakpoints, stepping, and variable inspection are ready

**You do NOT need to run `func start` manually before pressing F5.**

### Architecture

```
┌──────────────────────────────────────────────────┐
│  F5 pressed                                       │
│  ↓                                                │
│  resolveDebugConfiguration                        │
│  → Cleans up stale dlv on port 2345               │
│  → Starts background poller (fire-and-forget)     │
│  ↓                                                │
│  preLaunchTask: "func: host start"                │
│  → Builds app binary with debug symbols           │
│  → Starts Functions host + Go worker              │
│  ↓  (concurrently)                                │
│  Background poller detects app.exe PID            │
│  → Spawns: dlv attach <PID> --headless            │
│    --continue --listen=:2345 --api-version=2      │
│  ↓                                                │
│  Problem matcher: "Worker process started"        │
│  ↓                                                │
│  VS Code Go extension                             │
│  → Connects to dlv DAP on port 2345               │
│  → Breakpoints, stepping, variables work          │
└──────────────────────────────────────────────────┘
```

> The `--continue` flag is critical: it tells Delve to let the process keep running after attaching, preventing the Functions host from killing an unresponsive worker.

## Generated VS Code Configuration

When you initialize a Go Functions project, the extension generates these files:

### `.vscode/launch.json`

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Attach to Go Functions",
            "type": "go",
            "request": "attach",
            "mode": "remote",
            "port": 2345,
            "host": "127.0.0.1",
            "preLaunchTask": "func: host start"
        }
    ]
}
```

### `.vscode/tasks.json`

```json
{
    "version": "2.0.0",
    "tasks": [
        {
            "type": "func",
            "label": "func: host start",
            "command": "host start",
            "problemMatcher": "$func-golang-watch",
            "isBackground": true
        }
    ]
}
```

> **Important:** The `problemMatcher` and `isBackground` fields are required. Without them, VS Code won't know when `func host start` is ready and will show a warning dialog.

## Setting Breakpoints

1. Open your Go function handler file
2. Click in the gutter (left margin) next to a line in your handler function to set a breakpoint
3. Press **F5** to start debugging
4. Trigger your function (e.g., send an HTTP request to `http://localhost:7071/api/your-function`)
5. The debugger will pause at your breakpoint

> **Tip:** Set breakpoints inside your handler functions, not just in `main()`. The `main()` function runs during startup, but your handler runs when the function is triggered.

## Troubleshooting

### "dlv" command not found

Install Delve:
```bash
go install github.com/go-delve/delve/cmd/dlv@latest
```

Ensure `$GOPATH/bin` (or `%GOPATH%\bin` on Windows) is in your PATH. Restart VS Code after installing.

### "go.mod file not found"

Your project needs a Go module. Run:
```bash
go mod init your-module-name
go mod tidy
```

### "Failed to attach: Process has exited"

This usually means a stale Delve instance from a previous debug session is still bound to port 2345. The extension cleans these up automatically, but if it persists:

```bash
# Windows
tasklist /FI "IMAGENAME eq dlv.exe"
taskkill /PID <dlv_pid> /F

# Linux/macOS
pkill dlv
```

Then retry F5.

### Port 2345 already in use

Another Delve instance may be running. The extension auto-cleans stale instances, but you can also manually kill them (see above).

### "The task has not exited and doesn't have a problemMatcher"

Your `.vscode/tasks.json` is missing the problem matcher. Ensure the `func: host start` task has:
```json
"problemMatcher": "$func-golang-watch",
"isBackground": true
```

### Breakpoints not hit

- Ensure breakpoints are in handler functions, not just `main()`
- Verify the Go binary was built with debug symbols (no `-ldflags="-s -w"`)
- Check that the debug toolbar appears in VS Code (indicates the debugger is attached)

## Manual Debugging Flow

If the automated flow doesn't work, you can debug manually:

1. **Start the Functions host:**
   ```bash
   func start
   ```

2. **Find the app process PID:**
   ```bash
   # Windows
   tasklist /FI "IMAGENAME eq app.exe"

   # Linux/macOS
   pgrep -x app
   ```

3. **Attach Delve:**
   ```bash
   dlv attach <PID> --headless --continue --listen=:2345 --api-version=2 --accept-multiclient
   ```

4. **Press F5** in VS Code (with the launch.json configured above, but remove the `preLaunchTask` line)

## Known Limitations

- Go function templates are not yet available through the extension — create projects manually for now
- The extension does not auto-install Delve; you must install it yourself
- The Go worker runtime must be set to `golang` in your project's `local.settings.json`
