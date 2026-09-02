import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "*.lhr.life",
    "*.tunnelmole.net",
    "*.loca.lt",
    "*.trycloudflare.com",
    "localhost",
    "127.0.0.1",
  ],
};

export default nextConfig;
