#!/usr/bin/env bash
#
# Verifies which Node.js patch level the deployed Lambda runtime actually provides.
#
# AWS updates the managed nodejs24.x runtime on its own schedule, so the runtime
# identifier (nodejs24.x) alone does not tell whether a Node.js security fix is already
# in use - for example CVE-2026-111497 ("Node2Shell", Brotli decoder RCE) which is fixed
# in Node.js 24.22.1 / 22.23.4 / 26.12.1. The collector Lambda logs
# "NODE_VERSION <version>" on every hourly run, so the newest log entry tells the real
# version. Logging process.version is the method AWS documents for Node.js runtimes.
#
# Usage:
#   bash devops/check-node-runtime.sh
#
# Environment variables:
#   MIN_VERSION        Minimum patched Node.js version to require (default 24.22.1)
#   FUNCTION_PREFIX    Lambda function name prefix to look up (default the collector)
#   LOOKBACK_MINUTES   How far back to search CloudWatch Logs (default 1440)
#
# Exit codes:
#   0 = patched, 1 = older than MIN_VERSION, 2 = function not found,
#   3 = no NODE_VERSION entry within the lookback window

set -euo pipefail

MIN_VERSION="${MIN_VERSION:-24.22.1}"
FUNCTION_PREFIX="${FUNCTION_PREFIX:-TrafficStatsStack-TrafficCollectorLambda}"
LOOKBACK_MINUTES="${LOOKBACK_MINUTES:-1440}"

FUNCTION_NAME=$(aws lambda list-functions \
  --query "Functions[?starts_with(FunctionName, '${FUNCTION_PREFIX}')].FunctionName" \
  --output text | tr '\t' '\n' | grep -v '^None$' | head -1 || true)

if [ -z "$FUNCTION_NAME" ] || [ "$FUNCTION_NAME" = "None" ]; then
  echo "ERROR: no Lambda function found with prefix '${FUNCTION_PREFIX}'" >&2
  exit 2
fi

LOG_GROUP="/aws/lambda/${FUNCTION_NAME}"
START_TIME=$(( ($(date +%s) - LOOKBACK_MINUTES * 60) * 1000 ))

RUNTIME_MESSAGE=$(aws logs filter-log-events \
  --log-group-name "$LOG_GROUP" \
  --filter-pattern INIT_START \
  --start-time "$START_TIME" \
  --output text)

NODE_MESSAGE=$(aws logs filter-log-events \
  --log-group-name "$LOG_GROUP" \
  --filter-pattern NODE_VERSION \
  --start-time "$START_TIME" \
  --output text)

RUNTIME_VERSION=$(printf '%s' "$RUNTIME_MESSAGE" | tr '\t' '\n' \
  | grep -o 'Runtime Version: nodejs:[^ ]*' | tail -1 | sed 's/^Runtime Version: //' || true)
VERSION=$(printf '%s' "$NODE_MESSAGE" | tr '\t' '\n' \
  | grep -o 'NODE_VERSION v[0-9][0-9.]*' | tail -1 | sed 's/^NODE_VERSION v//' || true)

if [ -z "$VERSION" ]; then
  echo "No NODE_VERSION entry in $LOG_GROUP within the last ${LOOKBACK_MINUTES} minutes."
  echo "The collector runs hourly at minute 5 (UTC) - run this script again after the next run."
  exit 3
fi

echo "Function:       $FUNCTION_NAME"
echo "Runtime:        ${RUNTIME_VERSION:-unknown}"
echo "Node.js:        v${VERSION}"
echo "Required:       >= v${MIN_VERSION} (CVE-2026-111497 / Node2Shell)"
echo

LOWEST=$(printf '%s\n%s\n' "$MIN_VERSION" "$VERSION" | sort -V | head -1)

if [ "$LOWEST" = "$MIN_VERSION" ]; then
  echo "OK: the runtime is patched for CVE-2026-111497."
  exit 0
fi

echo "NOT PATCHED YET: the runtime provides Node.js v${VERSION}, but v${MIN_VERSION} or newer is required."
echo "AWS updates the managed nodejs24.x runtime in place (runtime management = Auto), so no"
echo "redeploy is needed. Run this script again later - the collector logs the version hourly."
exit 1
