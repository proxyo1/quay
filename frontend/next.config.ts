import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // Avoid picking ~/package-lock.json when multiple lockfiles exist.
    root: process.cwd(),
  },
};

export default nextConfig;
