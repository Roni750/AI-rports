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
    "/api/**": ["./data/aviation.db", "./data/analytics.db"],
    /**
     * Both keys are needed, and this is the trap worth remembering: the glob `"/analytics/**"`
     * does NOT match `/analytics` itself, so the dashboard route needs its own entry alongside the
     * one covering its children.
     *
     * These matter only when ANALYTICS_DB_URL is a `file:` URL. A deployment pointed at Turso
     * reads over HTTP and needs no bundled file — but a deploy that forgets to set the variable
     * falls back to the local file, and failing with a missing-file error is a far worse outcome
     * than shipping a small database nobody reads.
     */
    "/analytics": ["./data/analytics.db"],
    "/analytics/**": ["./data/analytics.db"],
  },
};

export default nextConfig;
