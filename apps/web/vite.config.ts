import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** 读取 daemon 启动时写入的端口和 token */
function readDaemonConfig(): { port: number; token: string } | null {
  const dataDir = join(homedir(), "AppData", "Local", "CodexAutoRunner", "data");
  try {
    const apiJson = JSON.parse(readFileSync(join(dataDir, "api.json"), "utf8"));
    const token = readFileSync(join(dataDir, "car-api.token"), "utf8").trim();
    return { port: apiJson.port, token };
  } catch {
    return null;
  }
}

const daemonCfg = readDaemonConfig();
const daemonPort = daemonCfg?.port ?? 58179;
const daemonToken = daemonCfg?.token ?? "";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${daemonPort}`,
        changeOrigin: true,
        configure: (proxy) => {
          // 自动注入认证 token
          proxy.on("proxyReq", (proxyReq) => {
            if (daemonToken) {
              proxyReq.setHeader("X-Car-Token", daemonToken);
            }
          });
        },
      },
    },
  },
  build: { outDir: "dist" },
});
