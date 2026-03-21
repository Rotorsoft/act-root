import { existsSync, readFileSync } from "fs";
import { createServer } from "http";
import { streamGenerate } from "./ai.js";

// Load .env file if present (tsx doesn't always forward --env-file to Node)
for (const envPath of [".env", "libs/act-diagram/.env"]) {
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const match = line.match(/^(\w+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
    break;
  }
}

function parseBody(req: import("http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
  });
}

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // POST /api/generate — SSE streaming AI generation
  if (req.url === "/api/generate" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const input = JSON.parse(body) as {
        prompt: string;
        currentFiles?: { path: string; content: string }[];
        maxTokens?: number;
        model?: string;
        refine?: boolean;
      };
      streamGenerate(input, res);
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON");
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const PORT = parseInt(process.env.PORT || "4002", 10);
server.listen(PORT);
console.log(`Act Diagram AI server listening on http://localhost:${PORT}`);
