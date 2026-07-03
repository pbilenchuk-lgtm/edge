/** @type {import('next').NextConfig} */
const nextConfig = {
  // node:sqlite is a built-in native module — keep it external to the server bundle
  // so Next never tries to bundle/transpile it.
  serverExternalPackages: ["node:sqlite"],
};

export default nextConfig;
