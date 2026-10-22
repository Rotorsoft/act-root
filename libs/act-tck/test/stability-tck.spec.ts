import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStabilityTck } from "../src/index.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "stability"
);

// Source entries follow `./x.js` to `x.ts`; a plain import is left out,
// and a file re-exported twice (`shout`) appears once.
runStabilityTck({
  name: "source entry",
  entryPoints: { "": path.join(fixtures, "ts", "index.ts") },
});

// Declaration entries follow `./x.js` to `x.d.ts`.
runStabilityTck({
  name: "declaration entry",
  entryPoints: { "/types": path.join(fixtures, "dts", "index.d.ts") },
});
