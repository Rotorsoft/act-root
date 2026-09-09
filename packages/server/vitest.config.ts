/**
 * Vitest 5 no longer walks up to the repo-root config from a sub-package
 * working directory (#1652), and without it this package loses `globals`
 * and the `@rotorsoft/*` → source aliases — the second silently, by
 * testing a stale `dist/` instead of the working tree.
 *
 * Re-exporting keeps one config for the whole workspace: no copied alias
 * map, and nothing here to drift. It also fixes the directory rather than
 * one script, so a bare `vitest` run from this folder behaves like the
 * workspace run.
 */
export { default } from "../../vite.config.js";
