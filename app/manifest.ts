import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FlowGuard",
    short_name: "FlowGuard",
    description: "Unusual options flow screener",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [{ src: "/favicon.ico", sizes: "256x256", type: "image/x-icon" }],
  };
}
