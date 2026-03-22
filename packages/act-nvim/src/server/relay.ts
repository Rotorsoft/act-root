import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { scanDir, watchDir, type WatchEvent } from "./watcher.js";

const HTTP_PORT = parseInt(process.env.ACT_NVIM_HTTP_PORT ?? "4010", 10);
const TCP_PORT = parseInt(process.env.ACT_NVIM_TCP_PORT ?? "4011", 10);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
// Find dist/client/ whether running from dist/server/ (built) or src/server/ (dev)
const PACKAGE_ROOT = __dirname.includes("/dist/")
  ? join(__dirname, "..", "..")
  : join(__dirname, "..", "..");
const CLIENT_DIR = join(PACKAGE_ROOT, "dist", "client");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

// --- State ---
let browserWs: WebSocket | null = null;
let nvimSocket: Socket | null = null;
let nvimBuffer = "";
let fsWatcher: ReturnType<typeof watchDir> | null = null;
let lastFiles: object | null = null; // cache last "files" message for new browser connections

/** Send NDJSON message to Neovim */
function sendToNvim(msg: object) {
  if (nvimSocket?.writable) {
    nvimSocket.write(JSON.stringify(msg) + "\n");
  }
}

/** Send JSON message to browser via WebSocket */
function sendToBrowser(msg: object) {
  if (browserWs?.readyState === 1) {
    browserWs.send(JSON.stringify(msg));
  }
}

// --- HTTP server (serves built client) ---
const httpServer = createHttpServer(async (req, res) => {
  const rawUrl = req.url?.split("?")[0] ?? "/";
  const url = rawUrl === "/" ? "/index.html" : rawUrl;
  const filePath = join(CLIENT_DIR, url);
  console.log(`[relay] HTTP ${req.method} ${url} -> ${filePath}`);
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
});

// --- WebSocket server (browser connects here) ---
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws) => {
  console.log("[relay] browser connected");
  browserWs = ws;

  // replay last files to the new connection
  if (lastFiles) {
    ws.send(JSON.stringify(lastFiles));
  }

  // Notify Neovim that a browser is connected (so it can skip opening a new tab)
  sendToNvim({ type: "browserConnected" });

  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      // DiagramMessage → forward to Neovim
      if (msg.type === "navigate") {
        sendToNvim(msg);
      }
    } catch (e) {
      console.error("[relay] bad WS message:", e);
    }
  });

  ws.on("close", () => {
    console.log("[relay] browser disconnected");
    if (browserWs === ws) browserWs = null;
  });
});

// --- TCP server (Neovim connects here) ---
const tcpServer = createTcpServer((socket) => {
  console.log("[relay] neovim connected");
  nvimSocket = socket;
  nvimBuffer = "";

  // Tell Neovim if a browser is already connected
  const hasBrowser = browserWs !== null && browserWs.readyState === 1;
  socket.write(
    JSON.stringify({ type: "status", browserConnected: hasBrowser }) + "\n"
  );

  socket.on("data", (chunk) => {
    nvimBuffer += chunk.toString();
    const lines = nvimBuffer.split("\n");
    nvimBuffer = lines.pop()!; // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as {
          type: string;
          [key: string]: unknown;
        };
        void handleNvimMessage(msg);
      } catch (e) {
        console.error("[relay] bad TCP message:", e);
      }
    }
  });

  socket.on("close", () => {
    console.log("[relay] neovim disconnected");
    if (nvimSocket === socket) nvimSocket = null;
  });

  socket.on("error", (e) => {
    console.error("[relay] TCP error:", e.message);
  });
});

async function handleNvimMessage(msg: {
  type: string;
  [key: string]: unknown;
}) {
  switch (msg.type) {
    case "init": {
      const root = msg.root as string;
      console.log(`[relay] init: scanning ${root}`);

      // clean up previous watcher
      if (fsWatcher) {
        fsWatcher.close();
        fsWatcher = null;
      }

      try {
        // scan and send all files to browser
        const files = await scanDir(root);
        console.log(`[relay] found ${files.length} TypeScript files`);
        lastFiles = { type: "files", files };
        sendToBrowser(lastFiles);

        // watch for changes
        fsWatcher = watchDir(root, (event: WatchEvent) => {
          console.log(`[relay] ${event.type}: ${event.path}`);
          sendToBrowser(event);
        });
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        console.error(`[relay] scan failed: ${err}`);
        sendToNvim({ type: "error", message: `scan failed: ${err}` });
      }
      break;
    }

    case "fileChanged": {
      // Neovim buffer save — forward to browser
      sendToBrowser(msg);
      break;
    }
  }
}

// --- Start ---
httpServer.listen(HTTP_PORT, () => {
  console.log(`[relay] HTTP + WS on http://localhost:${HTTP_PORT}`);
});

tcpServer.listen(TCP_PORT, () => {
  console.log(`[relay] TCP on port ${TCP_PORT}`);
});

// graceful shutdown
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function shutdown() {
  console.log("[relay] shutting down");
  fsWatcher?.close();
  wss.close();
  httpServer.close();
  tcpServer.close();
  process.exit(0);
}
