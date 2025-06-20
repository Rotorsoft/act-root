import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";
import typescriptPlugin from "@typescript-eslint/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";
import prettierPlugin from "eslint-plugin-prettier";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default [
  ...compat.extends(
    "eslint:recommended",
    "plugin:@typescript-eslint/eslint-recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
    "prettier"
  ),
  {
    plugins: {
      "@typescript-eslint": typescriptPlugin,
      prettier: prettierPlugin,
    },

    languageOptions: {
      parser: typescriptParser,
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        project: "./tsconfig.eslint.json",
      },
    },

    rules: {
      "prettier/prettier": [
        "error",
        {
          tabWidth: 2,
          semi: true,
          singleQuote: false,
          bracketSpacing: true,
          trailingComma: "es5",
          plugins: ["prettier-plugin-organize-imports"],
        },
      ],

      "newline-per-chained-call": "off",

      "require-await": "off",
      "@typescript-eslint/require-await": "error",

      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],

      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { varsIgnorePattern: "^_.*" },
      ],

      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowShortCircuit: true },
      ],

      "@typescript-eslint/no-explicit-any": 0,
      "@typescript-eslint/no-use-before-define": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-unsafe-declaration-merging": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-duplicate-type-constituents": "off",
    },
  },
];
