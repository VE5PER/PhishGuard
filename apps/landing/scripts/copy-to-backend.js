const fs = require("fs");
const path = require("path");

const OUT_DIR = path.resolve(__dirname, "../out");
const BACKEND_STATIC_DIR = path.resolve(__dirname, "../../backend/static");

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

if (fs.existsSync(OUT_DIR)) {
  copyDirRecursive(OUT_DIR, BACKEND_STATIC_DIR);
  console.log(`[PhishGuard] Synchronized landing page static build to ${BACKEND_STATIC_DIR}`);
} else {
  console.error(`[PhishGuard] Build output directory not found: ${OUT_DIR}`);
  process.exit(1);
}
