import { createHTTPServer } from "@trpc/server/adapters/standalone";
import cors from "cors";
import { inspectorRouter } from "./router.js";

const PORT = 4001;

const server = createHTTPServer({
  middleware: cors(),
  router: inspectorRouter,
});

server.listen(PORT, () => {
  console.log(`Inspector server listening on http://localhost:${PORT}`);
});
