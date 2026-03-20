#!/usr/bin/env bash
set -euo pipefail

echo "=== Claude Relay - MCP Bridge Setup ==="
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$SCRIPT_DIR/mcp-bridge"

# --- Check Node.js ---
if ! command -v node &> /dev/null; then
  echo "✗ Node.js is not installed."
  echo "  Install it from https://nodejs.org/ or via your package manager."
  exit 1
fi

NODE_VERSION=$(node -v)
# Extract major version number (e.g. v18.17.0 → 18)
NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)

if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ Node.js $NODE_VERSION is too old. Version 18 or higher is required."
  echo "  Current: $NODE_VERSION"
  echo "  Install a newer version from https://nodejs.org/"
  exit 1
fi

echo "✓ Node.js $NODE_VERSION"

# --- Check npm ---
if ! command -v npm &> /dev/null; then
  echo "✗ npm is not installed."
  echo "  It usually comes with Node.js. Try reinstalling Node.js from https://nodejs.org/"
  exit 1
fi

echo "✓ npm $(npm -v)"

# --- Check Claude CLI ---
if command -v claude &> /dev/null; then
  echo "✓ Claude CLI found"
else
  echo "⚠ Claude CLI not found."
  echo "  Install it from https://docs.anthropic.com/en/docs/claude-code"
  echo "  (Continuing setup anyway — you'll need it before you can chat.)"
  echo ""
fi

# --- Check mcp-bridge directory ---
if [ ! -d "$BRIDGE_DIR" ]; then
  echo "✗ mcp-bridge/ directory not found at: $BRIDGE_DIR"
  echo "  Make sure the folder structure is intact."
  exit 1
fi

if [ ! -f "$BRIDGE_DIR/package.json" ]; then
  echo "✗ mcp-bridge/package.json not found."
  echo "  The folder might be corrupted. Try re-downloading."
  exit 1
fi

# --- Install dependencies ---
echo ""
echo "Installing mcp-bridge dependencies..."

if ! (cd "$BRIDGE_DIR" && npm install); then
  echo ""
  echo "✗ npm install failed."
  echo "  Possible causes:"
  echo "    - No internet connection"
  echo "    - npm registry is down"
  echo "    - File permission issues (try: sudo chown -R \$(whoami) \"$BRIDGE_DIR\")"
  exit 1
fi

echo ""
echo "✓ Dependencies installed"

# --- Verify index.js exists ---
BRIDGE_INDEX="$BRIDGE_DIR/index.js"

if [ ! -f "$BRIDGE_INDEX" ]; then
  echo "✗ mcp-bridge/index.js not found. The folder might be corrupted."
  exit 1
fi

# --- Print MCP config ---
echo ""
echo "================================================"
echo "  Setup complete!"
echo "================================================"
echo ""
echo "Add the following to your ~/.claude.json file"
echo "(create it if it doesn't exist):"
echo ""
echo '{'
echo '  "mcpServers": {'
echo '    "claude-relay": {'
echo '      "type": "stdio",'
echo '      "command": "node",'
echo "      \"args\": [\"$BRIDGE_INDEX\"],"
echo '      "env": {'
echo '        "RELAY_URL": "wss://YOUR_RELAY_URL_HERE"'
echo '      }'
echo '    }'
echo '  }'
echo '}'
echo ""
echo "Replace YOUR_RELAY_URL_HERE with the relay server URL"
echo "provided by the person who invited you."
echo ""
echo "Then start Claude CLI and you're ready to go!"
