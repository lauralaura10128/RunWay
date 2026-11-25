#!/bin/bash
# RunWay - serve the app to your phone over HTTPS, so real GPS works.
#
# Your Mac has no GPS chip, so run tracking can only be tested on a phone.
# Phones only expose location over HTTPS, and your phone cannot reach your
# Mac's localhost. This opens a temporary HTTPS address that forwards to the
# server on this Mac. Nothing is published and no account is needed. The
# address stops working the moment you quit this script.

cd "$(dirname "$0")" || exit 1
PORT=8000
BAR="------------------------------------------------------------"

cleanup() {
  echo ""
  echo "$BAR"
  echo "Shutting down. The phone address no longer works."
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  rm -f phone-url.txt
  echo "$BAR"
  exit 0
}
trap cleanup INT TERM

clear
echo "$BAR"
echo "  RunWay -> your phone"
echo "$BAR"
echo ""

# ---- 1. the web server ---------------------------------------------------
if curl -s -o /dev/null --max-time 2 "http://localhost:$PORT/index.html"; then
  echo "[1/3] Web server already running on port $PORT."
else
  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 is not installed, so the files cannot be served."
    echo "Install Apple's command line tools with:  xcode-select --install"
    exit 1
  fi
  echo "[1/3] Starting the web server on port $PORT..."
  python3 -m http.server "$PORT" >/dev/null 2>&1 &
  SERVER_PID=$!
  sleep 2
  if ! curl -s -o /dev/null --max-time 3 "http://localhost:$PORT/index.html"; then
    echo "ERROR: the server did not come up. Is something else using port $PORT?"
    exit 1
  fi
  echo "      Started."
fi

# ---- 2. cloudflared -----------------------------------------------------
CF=""
if command -v cloudflared >/dev/null 2>&1; then
  CF="cloudflared"
  echo "[2/3] Found cloudflared already installed."
elif [ -x "./cloudflared" ]; then
  CF="./cloudflared"
  echo "[2/3] Using the cloudflared in this folder."
else
  echo "[2/3] Downloading cloudflared (about 40 MB, one time, stays in this folder)..."
  case "$(uname -m)" in
    arm64)  PKG="cloudflared-darwin-arm64.tgz" ;;
    x86_64) PKG="cloudflared-darwin-amd64.tgz" ;;
    *)      echo "ERROR: unrecognised Mac architecture $(uname -m)."; exit 1 ;;
  esac
  URL_DL="https://github.com/cloudflare/cloudflared/releases/latest/download/$PKG"
  if ! curl -fL --progress-bar -o cf.tgz "$URL_DL"; then
    echo ""
    echo "ERROR: could not download cloudflared. Check your internet connection."
    exit 1
  fi
  tar xzf cf.tgz >/dev/null 2>&1 && rm -f cf.tgz
  if [ ! -f cloudflared ]; then
    echo "ERROR: the download did not unpack as expected."
    exit 1
  fi
  chmod +x cloudflared
  CF="./cloudflared"
  echo "      Done."
fi

# ---- 3. the tunnel ------------------------------------------------------
echo "[3/3] Opening a temporary HTTPS address..."
rm -f tunnel.log phone-url.txt
"$CF" tunnel --url "http://localhost:$PORT" --no-autoupdate >tunnel.log 2>&1 &
TUNNEL_PID=$!

URL=""
for _ in $(seq 1 45); do
  URL=$(grep -oE 'https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com' tunnel.log 2>/dev/null | head -1)
  [ -n "$URL" ] && break
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo ""
    echo "ERROR: the tunnel stopped. Last few lines:"
    tail -5 tunnel.log
    cleanup
  fi
  sleep 1
done

if [ -z "$URL" ]; then
  echo ""
  echo "ERROR: no address appeared within 45 seconds. Last few lines:"
  tail -5 tunnel.log
  cleanup
fi

printf '%s\n' "$URL" > phone-url.txt
printf '%s' "$URL" | pbcopy 2>/dev/null

echo ""
echo "$BAR"
echo "  OPEN THIS ON YOUR PHONE"
echo ""
echo "    $URL"
echo ""
echo "  (also copied to your clipboard, and saved in phone-url.txt)"
echo "$BAR"
echo ""
echo "  On the phone: log in, open a route, then Start run."
echo "  iOS will ask for location - choose Allow While Using App."
echo ""
echo "  To check GPS quality first, open:"
echo "    $URL/gps-check.html"
echo ""
echo "  Leave this window open while you run."
echo "  Press Ctrl+C here when you are finished."
echo "$BAR"

wait "$TUNNEL_PID"
