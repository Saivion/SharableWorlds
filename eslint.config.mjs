import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const agentWriteGuard = {
  paths: [
    {
      name: "@/lib/placement",
      message:
        "Agent driving code cannot write shapes directly. Call the registered tools in lib/tools.ts.",
    },
    {
      name: "./placement",
      message:
        "Agent driving code cannot write shapes directly. Call the registered tools in lib/tools.ts.",
    },
  ],
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["lib/ambient.ts", "components/ChatPanel.tsx"],
    rules: { "no-restricted-imports": ["error", agentWriteGuard] },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
