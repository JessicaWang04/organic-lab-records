#!/bin/sh
set -eu

LAB_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CLI_PATH="$LAB_ROOT/scripts/organic-lab.cjs"
RUNTIME_FILE="$LAB_ROOT/runtime.json"
LAB_WINDOWS_SHELL=false
LAB_USING_BUNDLED_NODE=false
case "$(uname -s 2>/dev/null || printf '%s' unknown)" in
    MINGW*|MSYS*|CYGWIN*) LAB_WINDOWS_SHELL=true ;;
esac

if [ "$LAB_WINDOWS_SHELL" = true ] && [ -f "$LAB_ROOT/scripts/runtime/node.exe" ]; then
    LAB_NODE="$LAB_ROOT/scripts/runtime/node.exe"
    LAB_USING_BUNDLED_NODE=true
elif command -v node >/dev/null 2>&1; then
    LAB_NODE=$(command -v node)
elif command -v nodejs >/dev/null 2>&1; then
    LAB_NODE=$(command -v nodejs)
else
    printf '%s\n' 'Node was not found. Install Node 20 or later and make node/nodejs available in this shell.' >&2
    exit 1
fi

if [ ! -f "$CLI_PATH" ]; then
    printf '%s\n' 'The compiled scripts/organic-lab.cjs is missing. Use the built skill package.' >&2
    exit 1
fi

if [ -f "$RUNTIME_FILE" ]; then
    LAB_CONFIG_NODE=$("$LAB_NODE" -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(c.nodePath||"");' "$RUNTIME_FILE")
    if [ -n "$LAB_CONFIG_NODE" ] && [ -x "$LAB_CONFIG_NODE" ] && [ "$LAB_USING_BUNDLED_NODE" = false ]; then
        case "$LAB_CONFIG_NODE" in
            *.[eE][xX][eE])
                if [ "$LAB_WINDOWS_SHELL" = true ]; then LAB_NODE="$LAB_CONFIG_NODE"; fi
                ;;
            *) LAB_NODE="$LAB_CONFIG_NODE" ;;
        esac
    fi
fi

LAB_NODE_VERSION=$("$LAB_NODE" --version)
LAB_NODE_MAJOR=${LAB_NODE_VERSION#v}
LAB_NODE_MAJOR=${LAB_NODE_MAJOR%%.*}
case "$LAB_NODE_MAJOR" in
    ''|*[!0-9]*)
        printf '%s\n' "Cannot read the Node version: $LAB_NODE_VERSION" >&2
        exit 1
        ;;
esac
if [ "$LAB_NODE_MAJOR" -lt 20 ]; then
    printf '%s\n' "Node 20 or later is required. Found $LAB_NODE_VERSION at $LAB_NODE." >&2
    exit 1
fi

if [ -f "$RUNTIME_FILE" ]; then
    if [ -z "${ORGANIC_LAB_PYTHON:-}" ]; then
        ORGANIC_LAB_PYTHON=$("$LAB_NODE" -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(c.pythonPath||"");' "$RUNTIME_FILE")
        if [ -n "$ORGANIC_LAB_PYTHON" ]; then export ORGANIC_LAB_PYTHON; fi
    fi
fi

exec "$LAB_NODE" "$CLI_PATH" "$@"
