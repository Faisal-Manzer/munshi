import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @munshi/core ships TypeScript source, not a build artefact — one brain,
  // compiled by whoever consumes it (docs/E2EE.md §9 step 0)
  transpilePackages: ["@munshi/core"],
};

export default nextConfig;
