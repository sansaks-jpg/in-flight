import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure local .tmp directory exists to avoid Windows temp file locking issues
const localTmp = path.resolve(__dirname, ".tmp");
if (!fs.existsSync(localTmp)) {
  fs.mkdirSync(localTmp, { recursive: true });
}
process.env.TEMP = localTmp;
process.env.TMP = localTmp;

// Mirror src/assets/images to public/src/assets/images so static string paths work in production builds
const srcImages = path.resolve(__dirname, "src/assets/images");
const publicSrcImages = path.resolve(__dirname, "public/src/assets/images");
if (fs.existsSync(srcImages)) {
  fs.mkdirSync(publicSrcImages, { recursive: true });
  fs.cpSync(srcImages, publicSrcImages, { recursive: true });
}

// https://vite.dev/config/
export default defineConfig({
  server: {
    host: '0.0.0.0',
    allowedHosts: ['.e2b.app'],
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: ['.e2b.app'],
  },
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
