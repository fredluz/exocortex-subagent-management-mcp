#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

echo "[release-check] build"
bun run build

echo "[release-check] test"
bun run test

echo "[release-check] pack"
PACK_JSON="$(npm pack --json)"
TARBALL="$(node -e 'const payload = JSON.parse(process.argv[1]); if (!Array.isArray(payload) || payload.length === 0 || !payload[0].filename) process.exit(1); process.stdout.write(payload[0].filename);' "${PACK_JSON}")"

if tar -tzf "${TARBALL}" | grep -q "^package/src/"; then
  echo "[release-check] unexpected source files in tarball"
  rm -f "${TARBALL}"
  exit 1
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_DIR}"
  rm -f "${TARBALL}"
}
trap cleanup EXIT

echo "[release-check] local install smoke"
SMOKE_DIR="${TMP_DIR}/smoke"
mkdir -p "${SMOKE_DIR}"
cd "${SMOKE_DIR}"
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund "${ROOT_DIR}/${TARBALL}" >/dev/null

BIN_PATH="${SMOKE_DIR}/node_modules/.bin/exocortex-subagent-management-mcp"
if [[ ! -x "${BIN_PATH}" ]]; then
  echo "[release-check] bin entry missing or not executable: ${BIN_PATH}"
  exit 1
fi

node -e '
const { spawn } = require("node:child_process");
const bin = process.argv[1];
const child = spawn(bin, { stdio: ["pipe", "ignore", "ignore"] });
let settled = false;

child.once("error", (error) => {
  settled = true;
  console.error(error.message);
  process.exit(1);
});

child.once("spawn", () => {
  setTimeout(() => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }, 500);
});

child.once("exit", (code, signal) => {
  settled = true;
  if (code === 0 || signal === "SIGTERM") {
    process.exit(0);
  }
  console.error(`bin exited unexpectedly (code=${code}, signal=${signal})`);
  process.exit(1);
});

setTimeout(() => {
  if (settled) {
    return;
  }
  if (!child.killed) {
    child.kill("SIGKILL");
  }
  console.error("bin did not start in expected time window");
  process.exit(1);
}, 3000);
' "${BIN_PATH}"

echo "[release-check] OK (${TARBALL})"
