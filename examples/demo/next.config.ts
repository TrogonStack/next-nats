import type { NextConfig } from "next";
import { withNats } from "@trogonstack/next-nats/next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
};

export default withNats(nextConfig, { cache: true });
