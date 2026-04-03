# Monorepo Template

Complete workspace configuration files for scaffolding a new Act application.
Two packages: `domain` (pure logic) and `app` (server + client).

For code templates, see: [domain.md](domain.md) (states, slices, projections, tests) · [api.md](api.md) (tRPC router files) · [client.md](client.md) (React components & hooks) · [server.md](server.md) (dev/prod servers)

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
  "engines": { "node": ">=22.18.0", "pnpm": ">=10.32.1" },
  "packageManager": "pnpm@10.32.1",
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "typecheck": "npx tsc --noEmit --project tsconfig.json",
    "dev": "pnpm -F @my-app/app dev:api & pnpm -F @my-app/app dev:client",
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

> **Dev script**: Run API and Vite client as separate processes with `&`. The app package has `dev:api` (tsx watch) and `dev:client` (vite --host) scripts.

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
  "scripts": {
    "drizzle:generate": "drizzle-kit generate",
    "drizzle:migrate": "drizzle-kit migrate",
    "drizzle:push": "drizzle-kit push",
    "drizzle:studio": "drizzle-kit studio"
  },
  "dependencies": {
    "@rotorsoft/act": "^0.20.0",
    "drizzle-orm": "^0.45.1",
    "postgres": "^3.4.7",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "drizzle-kit": "^0.31.10"
  }
}
```

> **Drizzle migrations are CLI-only.** Never write programmatic migration code (custom `migrateDb()` functions using `drizzle-orm/migrator`). Use `drizzle-kit generate` to create migration files and `drizzle-kit migrate` to apply them. Migration files and `meta/` snapshots are committed to git.

## Domain drizzle.config.ts

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/drizzle/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/myapp",
  },
});
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
    "db:migrate": "cd ../domain && pnpm drizzle-kit migrate",
    "dev": "tsx watch src/dev-server.ts",
    "dev:api": "pnpm db:migrate && tsx watch src/dev-server.ts",
    "dev:client": "vite --host",
    "build": "vite build && tsc -p tsconfig.server.json",
    "start": "pnpm db:migrate && node dist/server.js"
  },
  "dependencies": {
    "@my-app/domain": "workspace:*",
    "@rotorsoft/act": "^0.20.0",
    "@rotorsoft/act-sse": "^0.1.0",
    "@tanstack/react-query": "^5.90.21",
    "@trpc/client": "11.10.0",
    "@trpc/react-query": "11.10.0",
    "@trpc/server": "11.10.0",
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

## Install Commands

```bash
mkdir my-app && cd my-app
pnpm init
mkdir -p packages/domain/{src,test} packages/app/src/{api,client/{hooks,components,views,styles,data}}

# Root devDependencies
pnpm add -Dw typescript tsx vitest @vitest/coverage-v8

# Domain
pnpm -F @my-app/domain add @rotorsoft/act drizzle-orm postgres zod
pnpm -F @my-app/domain add -D drizzle-kit

# App (server + client combined)
pnpm -F @my-app/app add @my-app/domain @rotorsoft/act @rotorsoft/act-sse @trpc/server @trpc/client @trpc/react-query @tanstack/react-query cors react react-dom zod
pnpm -F @my-app/app add -D @types/cors @types/react @types/react-dom @vitejs/plugin-react typescript vite
```
