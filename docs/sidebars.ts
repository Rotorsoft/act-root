import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    "intro",
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
          label: "@rotorsoft/act-sse",
          href: "/docs/api/act-sse/src",
        },
      ],
    },
  ],
};

export default sidebars;
