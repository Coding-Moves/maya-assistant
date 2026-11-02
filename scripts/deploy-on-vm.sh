#!/usr/bin/env bash
# Install as root-owned /usr/local/sbin/maya-deploy, called by the VM timer.
set -Eeuo pipefail
umask 077

app=/opt/maya-assistant
archive="$app/data/deploy-inbox/release.tar.gz"
revision_file="$app/data/deploy-inbox/release.sha"
check_only=0
if [[ $# -eq 1 && $1 == --check ]]; then
  check_only=1
elif (( $# != 0 )); then
  echo 'Usage: maya-deploy [--check]' >&2
  exit 2
fi

[[ -f "$archive" && -f "$revision_file" ]] || { echo 'Missing release archive or revision' >&2; exit 1; }
revision=$(cat "$revision_file")
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid release revision' >&2; exit 1; }
if (( ! check_only )) && [[ -f "$app/.deployed-commit" && $(cat "$app/.deployed-commit") == "$revision" ]]; then
  echo "Already deployed $revision"
  exit 0
fi

# Reject links, traversal and private paths in GitHub's prefixed archive.
python3 - "$archive" <<'PY'
import pathlib, sys, tarfile

blocked = {'.env', 'auth_info', 'data', 'node_modules', '.git', '.deployed-commit'}
with tarfile.open(sys.argv[1], 'r:gz') as bundle:
    total = 0
    prefix = None
    for member in bundle:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts:
            raise SystemExit(f'Unsafe archive entry: {member.name}')
        if prefix is None:
            prefix = path.parts[0]
        if path.parts[0] != prefix or not (member.isfile() or member.isdir()):
            raise SystemExit(f'Unsafe archive entry: {member.name}')
        relative = path.parts[1:]
        if relative and relative[0] in blocked:
            raise SystemExit(f'Private archive entry: {member.name}')
        total += member.size
        if total > 100_000_000:
            raise SystemExit('Release archive exceeds size limit')
PY

stage=$(mktemp -d "$app/.deploy-stage.XXXXXXXX")
backup=
old_revision=$(cat "$app/.deployed-commit" 2>/dev/null || true)
stopped=0
deps_changed=0
cleanup() {
  result=$?
  if (( result != 0 && stopped )); then
    echo 'Deployment failed; restoring previous source' >&2
    rm -rf "$app/src" "$app/scripts"
    tar -xzf "$backup" -C "$app" || true
    if [[ -d "$app/.deploy-old-node_modules" ]]; then
      rm -rf "$app/node_modules"
      mv "$app/.deploy-old-node_modules" "$app/node_modules"
    fi
    if [[ -n "$old_revision" ]]; then
      printf '%s\n' "$old_revision" > "$app/.deployed-commit"
    else
      rm -f "$app/.deployed-commit"
    fi
    systemctl start maya || true
  fi
  rm -rf "$stage"
  exit "$result"
}
trap cleanup EXIT

tar -xzf "$archive" --strip-components=1 --no-same-owner --no-same-permissions -C "$stage"
chown -R maya:maya "$stage"
[[ -d "$stage/src" && -d "$stage/scripts" && -f "$stage/package.json" && -f "$stage/package-lock.json" ]] || {
  echo 'Release is missing required application files' >&2
  exit 1
}
if (( check_only )); then
  echo "Validated release $revision"
  exit 0
fi
if ! cmp -s "$app/package-lock.json" "$stage/package-lock.json"; then
  deps_changed=1
  runuser -u maya -- npm ci --prefix "$stage" --no-audit --no-fund
fi

backup="$app/data/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)-source.tar.gz"
runuser -u maya -- tar -czf "$backup" -C "$app" src scripts package.json package-lock.json
systemctl stop maya
stopped=1

if (( deps_changed )); then
  [[ ! -e "$app/.deploy-old-node_modules" ]] || { echo 'Old dependency rollback dir exists' >&2; exit 1; }
  mv "$app/node_modules" "$app/.deploy-old-node_modules"
  mv "$stage/node_modules" "$app/node_modules"
fi
rm -rf "$app/src" "$app/scripts"
runuser -u maya -- cp -a "$stage/." "$app/"
printf '%s\n' "$revision" > "$app/.deployed-commit"
chown maya:maya "$app/.deployed-commit"
systemctl start maya
sleep 5
systemctl is-active --quiet maya || { echo 'Maya did not stay active' >&2; exit 1; }
stopped=0
if (( deps_changed )); then rm -rf "$app/.deploy-old-node_modules"; fi
rm -f "$archive" "$revision_file"
echo "Deployed $revision; Maya is active"
