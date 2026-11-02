#!/usr/bin/env python3
"""VM-side poller: deploy the latest successful CI run for public main."""

import json
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.request

APP = pathlib.Path('/opt/maya-assistant')
INBOX = APP / 'data' / 'deploy-inbox'
RUNS_URL = 'https://api.github.com/repos/Coding-Moves/maya-assistant/actions/workflows/deploy.yml/runs?branch=main&event=push&per_page=1'
BRANCH_URL = 'https://api.github.com/repos/Coding-Moves/maya-assistant/branches/main'
ARCHIVE_BASE = 'https://api.github.com/repos/Coding-Moves/maya-assistant/tarball/'
MAX_ARCHIVE_BYTES = 20_000_000
HEADERS = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'maya-assistant-deploy',
}


def request(url: str):
    return urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=20)


def latest_passing_revision() -> str | None:
    try:
        with request(RUNS_URL) as response:
            runs = json.load(response)['workflow_runs']
    except urllib.error.HTTPError as error:
        if error.code == 404:  # The workflow is not on main until this setup is merged.
            return None
        raise
    if not runs:
        return None
    run = runs[0]
    if (run.get('event') != 'push' or run.get('head_branch') != 'main'
            or run.get('status') != 'completed' or run.get('conclusion') != 'success'):
        return None
    revision = run.get('head_sha', '')
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('GitHub returned an invalid commit SHA')
    with request(BRANCH_URL) as response:
        head = json.load(response)['commit']['sha']
    if revision != head:
        return None
    return revision


def main() -> None:
    revision = latest_passing_revision()
    if not revision:
        print('No successful main CI run yet; leaving Maya unchanged')
        return
    marker = APP / '.deployed-commit'
    if marker.exists() and marker.read_text().strip() == revision:
        print(f'Already deployed {revision}')
        return

    INBOX.mkdir(mode=0o700, exist_ok=True)
    pending = INBOX / 'release.tar.gz.pending'
    size = 0
    try:
        with request(ARCHIVE_BASE + revision) as response, pending.open('wb') as output:
            for chunk in iter(lambda: response.read(64 * 1024), b''):
                size += len(chunk)
                if size > MAX_ARCHIVE_BYTES:
                    raise ValueError('GitHub archive exceeds size limit')
                output.write(chunk)
        pending.replace(INBOX / 'release.tar.gz')
        (INBOX / 'release.sha').write_text(revision + '\n')
        subprocess.run(['/usr/local/sbin/maya-deploy'], check=True)
    finally:
        pending.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Maya deployment check failed: {type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
