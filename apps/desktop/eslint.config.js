import i18next from "eslint-plugin-i18next";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      i18next,
    },
    rules: {
      // Catch text in JSX that should be translated
      "i18next/no-literal-string": [
        "error",
        {
          markupOnly: true, // Only check JSX content, not all strings
          ignoreAttribute: [
            "className",
            "style",
            "type",
            "id",
            "name",
            "key",
            "data-*",
            "aria-*",
          ], // Ignore common non-translatable attributes
        },
      ],
    },
  },
  {
    // Nook's pages listen on their own window only: Tauri hands an event sent to any one
    // window to every global listen(), so the bar would hear the panel's state.
    files: ["src/nook/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@tauri-apps/api/event",
              importNames: ["listen", "once"],
              message:
                "Use getCurrentWebviewWindow().listen() so the page hears only its own window's events.",
            },
          ],
        },
      ],
    },
  },
];
