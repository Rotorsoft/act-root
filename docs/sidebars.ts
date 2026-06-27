import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    "intro",
    {
      type: "category",
      label: "Guides",
      collapsed: false,
      items: [
        "guides/getting-started",
        "guides/projections-to-database",
        "guides/external-integration",
        "guides/auto-generated-api",
        "guides/close-policies",
        "guides/sensitive-data",
        "guides/pii-encryption-at-rest",
        "guides/production-checklist",
        "guides/contributing-new-package",
        "guides/writing-a-store",
        "guides/writing-a-cache",
        "guides/writing-a-logger",
        "guides/tck-conformance",
      ],
    },
    {
      type: "category",
      label: "Concepts",
      items: [
        "concepts/state-management",
        "concepts/event-sourcing",
        "concepts/configuration",
        "concepts/testing",
        "concepts/error-handling",
        "concepts/real-time",
      ],
    },
    {
      type: "category",
      label: "Examples",
      items: ["examples/calculator", "examples/wolfdesk"],
    },
    {
      type: "category",
      label: "Architecture",
      link: { type: "doc", id: "architecture/architecture" },
      items: [
        "architecture/concurrency-model",
        "architecture/cache-and-snapshots",
        "architecture/correlation-and-drain",
        "architecture/cross-process-reactions",
        "architecture/priority-lanes",
        "architecture/close-cycle",
        "architecture/event-schema-evolution",
        "architecture/design-decisions",
        "architecture/extension-points",
        "architecture/behavior-contracts",
      ],
    },
    {
      type: "category",
      label: "API Reference",
      collapsed: false,
      items: [
        {
          type: "link",
          label: "@rotorsoft/act",
          href: "/docs/api/act/src",
        },
        {
          type: "link",
          label: "@rotorsoft/act-patch",
          href: "/docs/api/act-patch/src",
        },
        {
          type: "link",
          label: "@rotorsoft/act-pg",
          href: "/docs/api/act-pg/src",
        },
        {
          type: "link",
          label: "@rotorsoft/act-sqlite",
          href: "/docs/api/act-sqlite/src",
        },
        {
          type: "link",
          label: "@rotorsoft/act-http (webhook)",
          href: "/docs/api/act-http/src/webhook",
        },
        {
          type: "link",
          label: "@rotorsoft/act-http (receiver)",
          href: "/docs/api/act-http/src/receiver",
        },
        {
          type: "link",
          label: "@rotorsoft/act-http (trpc)",
          href: "/docs/api/act-http/src/trpc",
        },
        {
          type: "link",
          label: "@rotorsoft/act-http (hono)",
          href: "/docs/api/act-http/src/hono",
        },
        {
          type: "link",
          label: "@rotorsoft/act-http (openapi)",
          href: "/docs/api/act-http/src/openapi",
        },
        {
          type: "link",
          label: "@rotorsoft/act-ops/idempotency",
          href: "/docs/api/act-ops/src/idempotency",
        },
        {
          type: "link",
          label: "@rotorsoft/act-crypto",
          href: "/docs/api/act-crypto/src",
        },
        {
          type: "link",
          label: "@rotorsoft/act-tck",
          href: "/docs/api/act-tck/src",
        },
      ],
    },
  ],
};

export default sidebars;
