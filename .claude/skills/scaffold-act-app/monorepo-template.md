# Monorepo Template

Complete workspace configuration files for scaffolding a new Act application.
Two packages: `domain` (pure logic) and `app` (server + client).

## pnpm-workspace.yaml

```yaml
packages:
  - packages/*
```

## Root package.json

```json
{
  "name": "my-app",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.18.0", "pnpm": ">=10.27.0" },
  "packageManager": "pnpm@10.29.3",
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "typecheck": "npx tsc --noEmit --project tsconfig.json",
    "dev": "pnpm -F @my-app/app dev",
    "start": "pnpm -F @my-app/app start"
  },
  "devDependencies": {
    "@vitest/coverage-v8": "^4.0.18",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3",
    "vitest": "^4.0.18"
  }
}
```

## tsconfig.base.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "types": ["node", "vitest/globals"]
  }
}
```

## vitest.config.ts

```typescript
import { defineConfig } from "vite";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      include: ["packages/domain/src/**/*.ts"],
    },
  },
});
```

## Domain package — packages/domain/package.json

```json
{
  "name": "@my-app/domain",
  "type": "module",
  "version": "0.0.1",
  "main": "./src/index.ts",
  "dependencies": {
    "@rotorsoft/act": "^0.11.1",
    "zod": "^4.3.6"
  }
}
```

## Domain tsconfig — packages/domain/tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*", "test/**/*"]
}
```

## App package — packages/app/package.json

```json
{
  "name": "@my-app/app",
  "type": "module",
  "version": "0.0.1",
  "scripts": {
    "dev": "tsx watch src/dev-server.ts",
    "build": "vite build && tsc -p tsconfig.server.json",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@my-app/domain": "workspace:*",
    "@rotorsoft/act": "^0.11.1",
    "@tanstack/react-query": "^5.90.21",
    "@trpc/client": "11.9.0",
    "@trpc/react-query": "11.9.0",
    "@trpc/server": "11.9.0",
    "cors": "^2.8.6",
    "react": "^19.2.4",
    "react-dom": "^19.2.4",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/cors": "^2.8.19",
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^5.1.4",
    "typescript": "~5.9.3",
    "vite": "^7.3.1"
  }
}
```

## App tsconfig — packages/app/tsconfig.json

References separate configs for client and server:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.server.json" }
  ]
}
```

## App tsconfig.app.json (client + API — bundler resolution, no emit)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/client", "src/api"]
}
```

## App tsconfig.server.json (server + API — emits JS)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "skipLibCheck": true,
    "strict": true,
    "esModuleInterop": true,
    "declaration": false
  },
  "include": ["src/server.ts", "src/api"]
}
```

## App vite.config.ts

```typescript
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
});
```

## App index.html (at packages/app/ root)

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/client/main.tsx"></script>
  </body>
</html>
```

## App dev-server.ts (Vite middleware mode — single process)

```typescript
// packages/app/src/dev-server.ts
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import cors from "cors";
import { router, app } from "./api/index.js";

// tRPC standalone server on port 4000
const server = createHTTPServer({ middleware: cors(), router });
server.listen(4000);

// Initial drain
await app.drain();
console.log("API server running at http://localhost:4000");
```

> **Note:** In dev mode, run the API server and Vite dev server as separate processes.
> Add a root script: `"dev": "concurrently 'pnpm -F @my-app/app dev:api' 'pnpm -F @my-app/app dev:client'"` and add `"dev:api": "tsx watch src/dev-server.ts"` and `"dev:client": "vite --host"` to the app package scripts. Alternatively, use Fastify with Vite middleware mode for a single-process dev server (see the [rent-stream](https://github.com/Rotorsoft/rent-stream) example).

## App server.ts (production — serves built client + API)

```typescript
// packages/app/src/server.ts
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import cors from "cors";
import { router, app } from "./api/index.js";

const server = createHTTPServer({ middleware: cors(), router });
const port = Number(process.env.PORT) || 4000;
server.listen(port);

await app.drain();
console.log(`Server listening on http://localhost:${port}`);
```

## App client — trpc.ts

```typescript
// packages/app/src/client/trpc.ts
import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../api/index.js";

export const trpc = createTRPCReact<AppRouter>();
```

## App client — App.tsx

```tsx
// packages/app/src/client/App.tsx
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpLink } from "@trpc/client";
import { trpc } from "./trpc.js";

export default function App() {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [httpLink({ url: "http://localhost:4000" })],
    })
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {/* Your components */}
      </QueryClientProvider>
    </trpc.Provider>
  );
}
```

## App client — main.tsx

```tsx
// packages/app/src/client/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

## Install Commands

```bash
mkdir my-app && cd my-app
pnpm init
mkdir -p packages/domain/{src,test} packages/app/src/{api,client}

# Root devDependencies
pnpm add -Dw typescript tsx vitest @vitest/coverage-v8

# Domain
pnpm -F @my-app/domain add @rotorsoft/act zod

# App (server + client combined)
pnpm -F @my-app/app add @my-app/domain @rotorsoft/act @trpc/server @trpc/client @trpc/react-query @tanstack/react-query cors react react-dom zod
pnpm -F @my-app/app add -D @types/cors @types/react @types/react-dom @vitejs/plugin-react typescript vite
```
