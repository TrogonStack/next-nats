import type { NextConfig } from "next";
import { withNats } from "next-nats/next";

const nextConfig: NextConfig = {
  cacheComponents: true,
};

export default withNats(nextConfig, { cache: true });
