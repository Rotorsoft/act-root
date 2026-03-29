import { createHTTPServer } from "@trpc/server/adapters/standalone";
import cors from "cors";
import { inspectorRouter } from "./router.js";

const PORT = parseInt(process.env.PORT || "4001", 10);

const server = createHTTPServer({
  middleware: cors({
    origin: (origin, callback) => {
      const allowed = process.env.CORS_ORIGIN;
      if (allowed) {
        callback(null, origin === allowed);
      } else {
        // In dev, allow any localhost origin (port may vary)
        const ok = !origin || /^https?:\/\/localhost(:\d+)?$/.test(origin);
        callback(null, ok);
      }
    },
  }),
  router: inspectorRouter,
});

server.listen(PORT, () => {
  console.log(`Inspector server listening on http://localhost:${PORT}`);
});
