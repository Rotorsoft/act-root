import { createHTTPServer } from "@trpc/server/adapters/standalone";
import cors from "cors";
import { builderRouter, streamGenerate } from "./router.js";

const corsMiddleware = cors();

const server = createHTTPServer({
  middleware: (req, res, next) => {
    corsMiddleware(req, res, () => {
      // SSE streaming endpoint — handle before tRPC
      if (req.url === "/generate-stream" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const input = JSON.parse(body) as {
              prompt: string;
              currentCode?: string;
              maxTokens?: number;
              model?: string;
              refine?: boolean;
            };
            void streamGenerate(input, res);
          } catch {
            res.writeHead(400);
            res.end("Invalid JSON");
          }
        });
        return;
      }
      next();
    });
  },
  router: builderRouter,
});
const PORT = parseInt(process.env.PORT || "4002", 10);
server.listen(PORT);
console.log(`Act Builder server listening on http://localhost:${PORT}`);
