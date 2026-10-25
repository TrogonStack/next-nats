import type { NextConfig } from "next";
import { withNats } from "@trogonstack/next-nats/next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  ...(process.env.NEXT_DIST_DIR && { distDir: process.env.NEXT_DIST_DIR }),
};

export default withNats(nextConfig, { cache: true });
