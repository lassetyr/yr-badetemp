#!/usr/bin/env bash
#
# Fire the "Poll water temperature" workflow via GitHub's REST API.
#
# This is the reliable alternative to the `schedule:` cron in poll.yml, which
# GitHub runs on a best-effort basis and frequently delays or drops. Point an
# external scheduler (e.g. cron-job.org) at this same request and it fires on
# time, every time.
#
# Usage:
#   GITHUB_TOKEN=ghp_xxx ./scripts/trigger.sh
#
# The token must be a fine-grained PAT scoped to this repo with the
# "Actions" permission set to "Read and write". A successful dispatch returns
# HTTP 204 with no body.
set -euo pipefail

REPO="lassetyr/yr-badetemp"
WORKFLOW="poll.yml"
REF="main"

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "error: set GITHUB_TOKEN (fine-grained PAT, repo Actions: read & write)" >&2
  exit 1
fi

status=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches" \
  -d "{\"ref\":\"${REF}\"}")

if [[ "$status" == "204" ]]; then
  echo "dispatched: ${WORKFLOW} on ${REF} (HTTP 204)"
else
  echo "dispatch failed: HTTP ${status} — check the token scope and repo/workflow name" >&2
  exit 1
fi
