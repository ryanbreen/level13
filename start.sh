#!/bin/sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$DIR/node_modules" ]; then
  echo "Installing Node.js dependencies..."
  cd "$DIR" && npm install --silent
fi

cd "$DIR"
# Fast esbuild bundle (< 100ms)
npx esbuild js/cli.jsx \
  --bundle --platform=node --format=esm \
  --outfile=dist/cli.js \
  --external:better-sqlite3 \
  --external:spotify-web-api-node \
  --external:yoga-wasm-web \
  --external:readline \
  --alias:react-devtools-core=./js/stub-devtools.js \
  "--banner:js=import { createRequire } from 'module'; const require = createRequire(import.meta.url);" \
  --log-level=silent

exec node dist/cli.js tui
