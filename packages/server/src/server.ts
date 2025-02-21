import { createHTTPServer } from "@trpc/server/adapters/standalone";
import cors from "cors";
import { router } from "./router";

const server = createHTTPServer({
  middleware: cors(),
  router,
});
server.listen(4000, () => {});
