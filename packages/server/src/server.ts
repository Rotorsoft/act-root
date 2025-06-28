import { calculatorRouter } from "@act/calculator";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import cors from "cors";

const server = createHTTPServer({
  middleware: cors(),
  router: calculatorRouter,
});
server.listen(4000, () => {});
