/** @type {import('next').NextConfig} */
const nextConfig = {
  // node:sqlite is a built-in native module — keep it external to the server
  // bundle so Next never tries to bundle/transpile it.
  serverExternalPackages: ["node:sqlite"],
  webpack: (config) => {
    // Our lib uses ESM-style ".js" import specifiers that actually point at
    // ".ts" files (so tsx/node can run them too). Teach webpack to resolve them.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
