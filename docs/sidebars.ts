import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

/**
 * Creating a sidebar enables you to:
 - create an ordered group of docs
 - render a sidebar for each doc of that group
 - provide next/previous navigation

 The sidebars can be generated from the filesystem, or explicitly defined here.

 Create as many sidebars as you want.
 */
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
          label: "@rotorsoft/act-pg",
          href: "/docs/api/act-pg/src",
        },
      ],
    },
  ],
};

export default sidebars;
