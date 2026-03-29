import { calculatorRouter } from "@act/calculator";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import cors from "cors";

const server = createHTTPServer({
  middleware: cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
  }),
  router: calculatorRouter,
});
server.listen(4000, () => {});
