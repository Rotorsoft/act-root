// Webpack `?raw` imports (wired in docusaurus.config.ts via an
// `asset/source` rule) return the file's contents as a string. This
// ambient declaration lets the landing page import real source files
// as text for its code samples.
declare module "*?raw" {
  const content: string;
  export default content;
}
