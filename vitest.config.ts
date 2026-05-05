import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        clearMocks: true,
        exclude: ["node_modules"],
        coverage: {
            provider: "v8",
            reportsDirectory: "coverage",
            reporter: ["text", "json-summary", "json", "lcovonly"],
            include: ["src/**/*.ts"],
            exclude: [
                "**/__fixtures__/**",
                "**/__mocks__/**",
                "**/__snapshots__/**",
                "**/*.spec.ts",
                "**/*.test.ts",
                "**/*.d.ts",
            ],
            thresholds: {
                statements: 100,
                branches: 100,
                functions: 100,
                lines: 100,
            },
        },
        pool: "threads",
        isolate: false,
        maxWorkers: 1,
        globals: false,
    },
});
