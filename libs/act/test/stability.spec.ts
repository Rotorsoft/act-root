import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStabilityTck } from "@rotorsoft/act-tck";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "src");

runStabilityTck({
  name: "@rotorsoft/act",
  entryPoints: {
    "": path.join(src, "index.ts"),
    "/types": path.join(src, "types", "index.ts"),
    "/test": path.join(src, "test", "index.ts"),
  },
});
