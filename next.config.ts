import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The SQLite dataset is read at runtime by the chat route, but nothing imports it as a module,
   * so Next's dependency tracing cannot see it and would omit it from the serverless bundle.
   * Without this the route works locally and fails in production with a missing-file error.
   *
   * Keys are route globs; values are globs resolved from the project root.
   */
  outputFileTracingIncludes: {
    "/api/**": ["./data/aviation.db"],
  },
};

export default nextConfig;
