import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type * as Preset from "@docusaurus/preset-classic";
import type { Config, Plugin } from "@docusaurus/types";
import { themes as prismThemes } from "prism-react-renderer";

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

// Read the landing-page quickstart as raw source at build time. Reading it here
// (Node, cwd = the docs site dir) guarantees the verbatim .ts text — types,
// `as const`, hand layout and all. A webpack `?raw` import does NOT: Docusaurus's
// babel/TS loader also matches the `.ts` file and transpiles it first, so `?raw`
// yields stripped, re-printed JS. The file is still type-checked by check:snippets.
const quickstartSource = readFileSync(
  resolve(process.cwd(), "src/snippets/quickstart.ts"),
  "utf8"
);

const config: Config = {
  title: "Act",
  tagline: "Fluent Event Sourcing for TypeScript",
  favicon: "img/favicon.ico",
  customFields: { quickstartSource },

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
    faster: true, // Enable Rust-based minifiers and faster build
  },

  // Set the production url of your site here
  url: "https://rotorsoft.github.io",
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: "/act-root/",

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: "rotorsoft", // Usually your GitHub org/user name.
  projectName: "act-root", // Usually your repo name.

  onBrokenLinks: "warn",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  headTags: [
    {
      tagName: "link",
      attributes: {
        rel: "preconnect",
        href: "https://fonts.googleapis.com",
      },
    },
    {
      tagName: "link",
      attributes: {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossorigin: "anonymous",
      },
    },
    {
      tagName: "link",
      attributes: {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700;800&display=swap",
      },
    },
    {
      tagName: "script",
      attributes: {
        src: "/act-root/coi-serviceworker.js",
      },
    },
  ],

  plugins: [
    function coopCoepHeadersPlugin(): Plugin {
      return {
        name: "coop-coep-headers",
        configureWebpack() {
          return {
            devServer: {
              headers: {
                "Cross-Origin-Opener-Policy": "same-origin",
                "Cross-Origin-Embedder-Policy": "require-corp",
              },
            },
          } as ReturnType<NonNullable<Plugin["configureWebpack"]>>;
        },
      };
    },
  ],

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: require.resolve("./sidebars.ts"),
          editUrl: "https://github.com/rotorsoft/act-root/edit/master/docs/",
          // Docs versioning. The live `docs/` folder is the "current" set and
          // stays the default served at `/docs/` so it always tracks the latest
          // API (docs are not frozen with library releases — see STABILITY.md).
          // Each breaking release snapshots a pinned copy via
          // `pnpm --filter docs exec docusaurus docs:version <version>`, which
          // older-major users can select from the navbar version dropdown.
          lastVersion: "current",
          versions: {
            current: {
              label: "Current",
              path: "",
            },
          },
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/og-image.png",
    colorMode: {
      defaultMode: "dark",
      respectPrefersColorScheme: true,
    },
    metadata: [
      {
        name: "description",
        content:
          "Act — TypeScript-first event sourcing framework. Fluent, composable state machines with reactions, projections, and built-in adapters for Postgres and SQLite.",
      },
      {
        name: "keywords",
        content:
          "event sourcing, typescript, cqrs, ddd, state machines, postgres, sqlite, zod",
      },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    announcementBar: {
      id: "act-book-2026",
      content:
        '<strong>📖 New:</strong> Read the <a target="_blank" rel="noopener noreferrer" href="https://payhip.com/b/7ezLy">Act book</a> — a hands-on guide to functional event sourcing in TypeScript.',
      backgroundColor: "transparent",
      textColor: "var(--ifm-navbar-link-color)",
      isCloseable: true,
    },
    navbar: {
      hideOnScroll: false,
      logo: {
        alt: "Act",
        src: "img/logo.png",
        srcDark: "img/logo-dark.png",
        href: "/",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docs",
          position: "left",
          label: "Docs",
        },
        {
          to: "/docs/examples/calculator",
          position: "left",
          label: "Examples",
        },
        {
          to: "/docs/architecture",
          position: "left",
          label: "Architecture",
        },
        {
          type: "docsVersionDropdown",
          position: "right",
        },
        {
          href: "https://payhip.com/b/7ezLy",
          label: "Book",
          position: "right",
        },
        {
          href: "https://github.com/rotorsoft/act-root",
          position: "right",
          className: "navbar-icon-link navbar-icon-github",
          "aria-label": "GitHub repository",
        },
      ],
    },
    footer: {
      style: "dark",
      logo: {
        alt: "Act Logo",
        src: "img/logo-dark.png",
        width: 36,
        height: 36,
      },
      links: [
        {
          title: "Learn",
          items: [
            { label: "Introduction", to: "/docs/intro" },
            { label: "Getting started", to: "/docs/guides/getting-started" },
            { label: "Architecture", to: "/docs/architecture" },
          ],
        },
        {
          title: "Examples",
          items: [
            { label: "Calculator", to: "/docs/examples/calculator" },
            { label: "WolfDesk", to: "/docs/examples/wolfdesk" },
          ],
        },
        {
          title: "Packages",
          items: [
            {
              label: "@rotorsoft/act",
              href: "https://www.npmjs.com/package/@rotorsoft/act",
            },
            {
              label: "@rotorsoft/act-pg",
              href: "https://www.npmjs.com/package/@rotorsoft/act-pg",
            },
            {
              label: "@rotorsoft/act-sqlite",
              href: "https://www.npmjs.com/package/@rotorsoft/act-sqlite",
            },
            {
              label: "@rotorsoft/act-http",
              href: "https://www.npmjs.com/package/@rotorsoft/act-http",
            },
            {
              label: "@rotorsoft/act-patch",
              href: "https://www.npmjs.com/package/@rotorsoft/act-patch",
            },
            {
              label: "@rotorsoft/act-pino",
              href: "https://www.npmjs.com/package/@rotorsoft/act-pino",
            },
            {
              label: "@rotorsoft/act-tck",
              href: "https://www.npmjs.com/package/@rotorsoft/act-tck",
            },
            {
              label: "@rotorsoft/act-diagram",
              href: "https://www.npmjs.com/package/@rotorsoft/act-diagram",
            },
          ],
        },
        {
          title: "Community",
          items: [
            { label: "GitHub", href: "https://github.com/rotorsoft/act-root" },
            {
              label: "Issues",
              href: "https://github.com/rotorsoft/act-root/issues",
            },
            { label: "Book", href: "https://payhip.com/b/7ezLy" },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Rotorsoft · Built with Docusaurus`,
    },
    prism: {
      theme: prismThemes.oneLight,
      darkTheme: prismThemes.oneDark,
      additionalLanguages: ["bash", "json", "typescript", "tsx"],
    },
    docs: {
      sidebar: {
        hideable: true,
        autoCollapseCategories: false,
      },
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
