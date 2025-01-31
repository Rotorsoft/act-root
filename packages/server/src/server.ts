import cors from "@fastify/cors";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify from "fastify";
import { generateOpenApiDocument } from "trpc-to-openapi";
import { createContext, router } from "./router";

const OAS = {
  title: "Calculator API",
  description: "Calculator API",
  version: "1.0.0",
  baseUrl: "http://localhost:4000/trpc",
};

declare module "fastify" {
  interface FastifyRequest {
    startTime?: [number, number]; // hrtime tuple
  }
}

async function bootstrap() {
  const fastify = Fastify({
    logger: {
      level: "info",
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          ignore: "pid,hostname",
          singleLine: true,
        },
      },
    },
    disableRequestLogging: true,
  });

  fastify.addHook("onRequest", (request, reply, done) => {
    if (request.method === "POST") request.startTime = process.hrtime(); // Capture request start time
    done();
  });

  fastify.addHook("onSend", (request, reply, payload, done) => {
    if (request.startTime) {
      const diff = process.hrtime(request.startTime);
      const responseTime = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(2); // Convert to ms
      const data = {
        body: JSON.parse(request.body as string),
        response: JSON.parse(payload as string),
      };
      const message = `${request.method} ${request.url} → ${reply.statusCode} (${responseTime}ms)`;
      if (reply.statusCode >= 400) request.log.error(data, message);
      else request.log.info(data, message);
    }
    done();
  });

  const oasDoc = generateOpenApiDocument(router, OAS);

  await fastify.register(cors, {
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
  });
  await fastify.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: { router, createContext },
  });
  // await fastify.register(fastifyTRPCOpenApiPlugin, { router });

  fastify.get("/openapi.json", (_, reply) => {
    reply.send(oasDoc);
  });

  fastify.listen({ port: 4000 }, () => {
    console.log("🚀 Server running at http://localhost:4000");
    console.log("📄 OpenAPI JSON: http://localhost:4000/openapi.json");
  });
}

void bootstrap().catch((err) => {
  console.error(err);
});
