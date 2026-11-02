import io
import os
import pathlib
import shlex
import subprocess
import tarfile
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'deploy-on-vm.sh'
OLD = 'a' * 40
NEW = 'b' * 40


class DeployOnVmTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        root = pathlib.Path(self.folder.name)
        self.app = root / 'app'
        self.app.mkdir()
        for name, value in {
            'src/old.ts': 'old',
            'src/removed.ts': 'remove on update',
            'scripts/old.sh': 'old script',
            'package.json': '{}',
            'package-lock.json': '{}',
            '.deployed-commit': OLD,
            '.env': 'private config',
            'auth_info/creds.json': 'private session',
            'data/maya.db': 'private database',
            'node_modules/marker': 'existing dependencies',
        }.items():
            path = self.app / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value)

        inbox = self.app / 'data' / 'deploy-inbox'
        inbox.mkdir()
        (inbox / 'release.sha').write_text(NEW + '\n')
        with tarfile.open(inbox / 'release.tar.gz', 'w:gz') as bundle:
            for name, value in {
                'src/new.ts': 'new',
                'scripts/new.sh': 'new script',
                'package.json': '{}',
                'package-lock.json': '{}',
            }.items():
                data = value.encode()
                info = tarfile.TarInfo(f'maya-{NEW}/{name}')
                info.size = len(data)
                bundle.addfile(info, io.BytesIO(data))

        self.script = root / 'maya-deploy'
        original = SCRIPT.read_text()
        self.assertEqual(original.count('app=/opt/maya-assistant'), 1)
        self.script.write_text(original.replace(
            'app=/opt/maya-assistant', f'app={shlex.quote(str(self.app))}', 1))
        self.script.chmod(0o755)

        fake_bin = root / 'fake-bin'
        fake_bin.mkdir()
        for name, body in {
            'runuser': 'shift 3\nexec "$@"',
            'systemctl': '[ "$1" != is-active ] || [ "${FAIL_ACTIVE:-0}" != 1 ]',
            'chown': 'exit 0',
            'sleep': 'exit 0',
            'npm': ('while [ "$#" -gt 0 ]; do\n'
                    '  if [ "$1" = --prefix ]; then shift; stage="$1"; fi\n'
                    '  shift\n'
                    'done\n'
                    'mkdir -p "$stage/node_modules"\n'
                    'printf "new dependencies" > "$stage/node_modules/marker"'),
        }.items():
            command = fake_bin / name
            command.write_text('#!/bin/sh\n' + body + '\n')
            command.chmod(0o755)
        self.path = str(fake_bin) + os.pathsep + os.environ['PATH']

    def deploy(self, fail_active=False):
        return subprocess.run(
            [str(self.script)],
            env={**os.environ, 'PATH': self.path,
                 'FAIL_ACTIVE': '1' if fail_active else '0'},
            text=True, capture_output=True, check=False,
        )

    def test_success_replaces_source_and_preserves_private_files(self):
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.app / 'src/new.ts').read_text(), 'new')
        self.assertFalse((self.app / 'src/removed.ts').exists())
        self.assertFalse((self.app / 'scripts/old.sh').exists())
        self.assertEqual((self.app / '.deployed-commit').read_text().strip(), NEW)
        self.assertEqual((self.app / '.env').read_text(), 'private config')
        self.assertEqual((self.app / 'auth_info/creds.json').read_text(), 'private session')
        self.assertEqual((self.app / 'data/maya.db').read_text(), 'private database')
        self.assertEqual((self.app / 'node_modules/marker').read_text(), 'existing dependencies')

    def test_failed_start_restores_exact_previous_source(self):
        (self.app / 'package-lock.json').write_text('{"old":true}')
        result = self.deploy(fail_active=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.app / 'src/old.ts').read_text(), 'old')
        self.assertEqual((self.app / 'src/removed.ts').read_text(), 'remove on update')
        self.assertFalse((self.app / 'src/new.ts').exists())
        self.assertEqual((self.app / 'scripts/old.sh').read_text(), 'old script')
        self.assertFalse((self.app / 'scripts/new.sh').exists())
        self.assertEqual((self.app / '.deployed-commit').read_text().strip(), OLD)
        self.assertEqual((self.app / 'package-lock.json').read_text(), '{"old":true}')
        self.assertEqual((self.app / 'node_modules/marker').read_text(), 'existing dependencies')


if __name__ == '__main__':
    unittest.main()
