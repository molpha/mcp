import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tmp/ holds vendored gateway/SDK source snapshots (with their own test
    // suites) used as reference material during development — they are not
    // part of this package and must not run under `npm test`.
    include: ["test/**/*.test.ts"]
  }
});
