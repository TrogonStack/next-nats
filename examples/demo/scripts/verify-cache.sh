#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export NATS_SERVERS="${NATS_SERVERS:-nats://nats.next-nats.orb.local:4222}"
export NEXT_NATS_CACHE_NAMESPACE="verify_$(date +%s)"
A=3103
B=3104
LOGS="${TMPDIR:-/tmp}/verify-cache-$$"
mkdir -p "$LOGS"

PIDS=()
stop() {
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    kill "$pid" 2>/dev/null || true
  done
  PIDS=()
}
trap stop EXIT

fail() { echo "FAIL: $*" >&2; echo "logs in $LOGS" >&2; exit 1; }

grab() { curl -fsS "http://127.0.0.1:$1$2" | grep -o "data-testid=\"$3\">[^<]*" | head -1 | sed 's/.*>//'; }

NEXT_BIN="$(node -p "require.resolve('next/dist/bin/next')")"

[ -d .next ] || node "$NEXT_BIN" build

CLOCK_ORIGIN=http://127.0.0.1:$A PORT=$A node "$NEXT_BIN" start -p $A >"$LOGS/a.log" 2>&1 &
PIDS+=($!)
CLOCK_ORIGIN=http://127.0.0.1:$A PORT=$B node "$NEXT_BIN" start -p $B >"$LOGS/b.log" 2>&1 &
PIDS+=($!)

for port in $A $B; do
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$port/api/nats/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -fsS "http://127.0.0.1:$port/api/nats/health" >/dev/null || fail "replica $port did not start"
done

a1=$(grab $A /cache nonce)
b1=$(grab $B /cache nonce)
echo "use cache, A: $a1  B: $b1"
[ -n "$a1" ] && [ "$a1" = "$b1" ] || fail "replicas do not share the use cache entry"

i1=$(grab $A /cache/isr isr-nonce)
j1=$(grab $B /cache/isr isr-nonce)
echo "fetch cache, A: $i1  B: $j1"
[ -n "$i1" ] && [ "$i1" = "$j1" ] || fail "replicas do not share the fetch cache entry"

call_action() {
  local port=$1 path=$2 label=$3
  local id
  id=$(curl -fsS "http://127.0.0.1:$port$path" | grep -o '\$ACTION_ID_[0-9a-f]*' | sed -n "${label}p" | sed 's/.*_//')
  [ -n "$id" ] || fail "no server action $label on $path"
  curl -fsS -o /dev/null -X POST "http://127.0.0.1:$port$path" \
    -H "Next-Action: $id" -H "Content-Type: text/plain;charset=UTF-8" --data '[]'
}

call_action $A /cache 1
for _ in $(seq 1 50); do
  b2=$(grab $B /cache nonce)
  [ "$b2" != "$b1" ] && break
  sleep 0.1
done
a2=$(grab $A /cache nonce)
echo "after updateTag on A, A: $a2  B: $b2"
[ "$b2" != "$b1" ] || fail "replica B still serves the expired use cache entry"
[ "$a2" = "$b2" ] || fail "replicas disagree after invalidation"

call_action $B /cache/isr 1
for _ in $(seq 1 50); do
  i2=$(grab $A /cache/isr isr-nonce)
  [ "$i2" != "$i1" ] && break
  sleep 0.1
done
j2=$(grab $B /cache/isr isr-nonce)
echo "after updateTag on B, A: $i2  B: $j2"
[ "$i2" != "$i1" ] || fail "replica A still serves the expired fetch cache entry"
[ "$i2" = "$j2" ] || fail "replicas disagree after fetch invalidation"

echo "OK"
