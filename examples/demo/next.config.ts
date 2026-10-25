import type { NextConfig } from "next";
import { withNats } from "next-nats/next";

const nextConfig: NextConfig = {};

export default withNats(nextConfig);
