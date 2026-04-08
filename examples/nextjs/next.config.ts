import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["chat2agent"],
  // discord.js / gateway stack uses optional native deps; keep them external to webpack
  serverExternalPackages: [
    "discord.js",
    "@discordjs/ws",
    "@discordjs/rest",
    "zlib-sync",
    "bufferutil",
    "utf-8-validate",
  ],
  webpack: (config, { isServer, webpack }) => {
    if (isServer) {
      // pnpm does not hoist optional peers; discord.js falls back to Node zlib without these.
      config.plugins.push(
        new webpack.IgnorePlugin({
          resourceRegExp: /^(zlib-sync|bufferutil|utf-8-validate)$/,
        }),
      );
    }
    return config;
  },
};

export default nextConfig;
