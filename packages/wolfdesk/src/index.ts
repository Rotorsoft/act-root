// Public surface of the wolfdesk example, so other examples (server,
// recipes, docs) can import the complex canonical model instead of
// redefining it. Mirrors `@act/calculator`'s barrel.
//
// `bootstrap.js` builds and exports the wolfdesk `app` and re-exports
// the slices (`./ticket.js`) and `./errors.js`; the schemas come from
// the `schemas` barrel.
export * from "./bootstrap.js";
export * as schemas from "./schemas/index.js";
