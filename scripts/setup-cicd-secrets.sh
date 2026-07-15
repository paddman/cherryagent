#!/bin/bash
# One-time GitHub Actions secrets setup for cherryagent deploy.
# Usage: GITHUB_TOKEN=ghp_xxx ./scripts/setup-cicd-secrets.sh
set -euo pipefail

REPO="paddman/cherryagent"
HOST="203.113.71.230"
USER="adminmc"
KEY_FILE="${HOME}/.ssh/github_deploy"

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "Set GITHUB_TOKEN (repo admin scope) then re-run."
  exit 1
fi

if [[ ! -f "$KEY_FILE" ]]; then
  echo "Missing deploy key: $KEY_FILE"
  exit 1
fi

export GH_TOKEN="$GITHUB_TOKEN"

gh auth status -h github.com >/dev/null 2>&1 || gh auth login --with-token <<<"$GITHUB_TOKEN"

gh secret set SERVER_HOST --repo "$REPO" --body "$HOST"
gh secret set SERVER_USER --repo "$REPO" --body "$USER"
gh secret set SSH_PRIVATE_KEY --repo "$REPO" < "$KEY_FILE"

echo "Secrets set on $REPO: SERVER_HOST, SERVER_USER, SSH_PRIVATE_KEY"
