import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'check-deploy.py'
spec = importlib.util.spec_from_file_location('check_deploy', SCRIPT)
check_deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_deploy)

REVISION = 'a' * 40


def response(data):
    return io.BytesIO(json.dumps(data).encode())


class DeployCheckTests(unittest.TestCase):
    def test_only_current_successful_main_run_is_eligible(self):
        run = {'event': 'push', 'head_branch': 'main', 'status': 'completed',
               'conclusion': 'success', 'head_sha': REVISION}

        def request(url):
            if url == check_deploy.RUNS_URL:
                return response({'workflow_runs': [run]})
            return response({'commit': {'sha': REVISION}})

        with patch.object(check_deploy, 'request', side_effect=request):
            self.assertEqual(check_deploy.latest_passing_revision(), REVISION)
            run['conclusion'] = 'failure'
            self.assertIsNone(check_deploy.latest_passing_revision())
            run['conclusion'] = 'success'
            run['head_branch'] = 'feature'
            self.assertIsNone(check_deploy.latest_passing_revision())
            run['head_branch'] = 'main'

        with patch.object(check_deploy, 'request', side_effect=lambda url: (
                response({'workflow_runs': [run]}) if url == check_deploy.RUNS_URL
                else response({'commit': {'sha': 'b' * 40}}))):
            self.assertIsNone(check_deploy.latest_passing_revision())

    def test_downloads_exact_revision_only_after_ci_passes(self):
        with tempfile.TemporaryDirectory() as temp:
            app = pathlib.Path(temp)
            (app / 'data').mkdir()
            inbox = app / 'data' / 'deploy-inbox'
            with (patch.object(check_deploy, 'APP', app),
                  patch.object(check_deploy, 'INBOX', inbox),
                  patch.object(check_deploy, 'latest_passing_revision', return_value=REVISION),
                  patch.object(check_deploy, 'request', return_value=io.BytesIO(b'archive')) as fetch,
                  patch.object(check_deploy.subprocess, 'run') as deploy):
                check_deploy.main()
                self.assertEqual((inbox / 'release.tar.gz').read_bytes(), b'archive')
                self.assertEqual((inbox / 'release.sha').read_text().strip(), REVISION)
                fetch.assert_called_once_with(check_deploy.ARCHIVE_BASE + REVISION)
                deploy.assert_called_once_with(['/usr/local/sbin/maya-deploy'], check=True)

                (app / '.deployed-commit').write_text(REVISION)
                check_deploy.main()
                deploy.assert_called_once()

    def test_rejects_oversized_archive_before_deploying(self):
        with tempfile.TemporaryDirectory() as temp:
            app = pathlib.Path(temp)
            (app / 'data').mkdir()
            inbox = app / 'data' / 'deploy-inbox'
            with (patch.object(check_deploy, 'APP', app),
                  patch.object(check_deploy, 'INBOX', inbox),
                  patch.object(check_deploy, 'MAX_ARCHIVE_BYTES', 3),
                  patch.object(check_deploy, 'latest_passing_revision', return_value=REVISION),
                  patch.object(check_deploy, 'request', return_value=io.BytesIO(b'oversized')),
                  patch.object(check_deploy.subprocess, 'run') as deploy):
                with self.assertRaisesRegex(ValueError, 'size limit'):
                    check_deploy.main()
                self.assertFalse((inbox / 'release.tar.gz').exists())
                self.assertFalse((inbox / 'release.tar.gz.pending').exists())
                deploy.assert_not_called()


if __name__ == '__main__':
    unittest.main()
