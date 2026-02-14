# Monorepo Template

Complete workspace configuration files for scaffolding a new Act application.

## pnpm-workspace.yaml

```yaml
packages:
  - packages/**
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
    "dev:server": "pnpm -F server dev",
    "dev:client": "pnpm -F client dev",
    "dev": "npx concurrently -n 'server,client' -c 'cyan,yellow' 'pnpm -F server dev' 'pnpm -F client dev'"
  },
  "devDependencies": {
    "@vitest/coverage-v8": "^4.0.18",
    "concurrently": "^9.1.0",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3",
    "vite": "^7.3.1",
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

## Server package — packages/server/package.json

```json
{
  "name": "@my-app/server",
  "type": "module",
  "version": "0.0.1",
  "scripts": { "dev": "tsx watch src/server.ts" },
  "dependencies": {
    "@my-app/domain": "workspace:*",
    "@rotorsoft/act": "^0.11.1",
    "@trpc/server": "11.9.0",
    "cors": "^2.8.6",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/cors": "^2.8.19"
  }
}
```

## Server tsconfig — packages/server/tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

## Client package — packages/client/package.json

```json
{
  "name": "@my-app/client",
  "type": "module",
  "version": "0.0.1",
  "scripts": { "dev": "vite --host" },
  "dependencies": {
    "@my-app/domain": "workspace:*",
    "@tanstack/react-query": "^5.90.21",
    "@trpc/client": "11.9.0",
    "@trpc/react-query": "11.9.0",
    "react": "^19.2.4",
    "react-dom": "^19.2.4"
  },
  "devDependencies": {
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^5.1.4",
    "typescript": "~5.9.3",
    "vite": "^7.3.1"
  }
}
```

## Client vite.config.ts

```typescript
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 3000 },
});
```

## Client tsconfig — packages/client/tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

## Client index.html

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
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

## Client App.tsx

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { client, queryClient, trpc } from "./trpc.js";

export default function App() {
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {/* Your components */}
      </QueryClientProvider>
    </trpc.Provider>
  );
}
```

## Client main.tsx

```tsx
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
mkdir -p packages/domain/{src,test} packages/server/src packages/client/src

# Root devDependencies
pnpm add -Dw typescript tsx vitest @vitest/coverage-v8 vite concurrently

# Domain
pnpm -F @my-app/domain add @rotorsoft/act zod

# Server
pnpm -F @my-app/server add @my-app/domain @rotorsoft/act @trpc/server cors zod
pnpm -F @my-app/server add -D @types/cors

# Client
pnpm -F @my-app/client add @my-app/domain @tanstack/react-query @trpc/client @trpc/react-query react react-dom
pnpm -F @my-app/client add -D @types/react @types/react-dom @vitejs/plugin-react typescript vite
```
