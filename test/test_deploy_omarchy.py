import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).parents[1] / 'scripts/deploy-omarchy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentTests(unittest.TestCase):
    def test_editor_origin_rejects_private_data_and_extra_components(self):
        self.assertEqual(deploy.normalized_origin('https://editor.example.test/'), 'https://editor.example.test')
        for value in ['http://editor.example.test', 'https://user:password@example.test',
                      'https://example.test/?token=hidden', 'https://example.test/path', 'https://example.test:invalid']:
            with self.assertRaises(deploy.DeploymentError):
                deploy.normalized_origin(value)

    def test_repository_identity_is_case_insensitive_and_omits_credentials(self):
        for url in ['https://github.com/BFoster59/LaunchPad.git',
                    'git@github.com:bfoster59/launchpad.git',
                    'ssh://git@github.com/bfoster59/launchpad',
                    'https://user:do-not-return@github.com/bfoster59/launchpad']:
            self.assertEqual(deploy.github_identity(url), 'bfoster59/launchpad')
        for url in ['https://evil.test/bfoster59/launchpad', 'file://github.com/bfoster59/launchpad',
                    'https://github.com/owner/repo?token=hidden', None]:
            self.assertIsNone(deploy.github_identity(url))

    def test_path_plan_checks_identity_and_holds_growing_without_reading_its_state(self):
        with tempfile.TemporaryDirectory() as directory:
            old, new = Path(directory) / 'old', Path(directory) / 'new'
            for root in [old, new]:
                (root / 'demo').mkdir(parents=True)
                (root / 'growing').mkdir()
            def identity(path):
                self.assertNotEqual(path.name, 'growing')
                return 'owner/demo'
            rows = [(1, 'demo', str(old / 'demo'), 'https://github.com/owner/demo'),
                    (2, 'growing', str(old / 'growing'), 'https://github.com/owner/growing')]
            changes, held = deploy.plan_paths(rows, old, new, identity)
            self.assertEqual(changes, [(1, str(old / 'demo'), str(new / 'demo'))])
            self.assertEqual(held, [2])
            with self.assertRaises(deploy.DeploymentError):
                deploy.plan_paths(rows[:1], old, new, lambda path: 'other/project')

    def test_changed_project_path_rolls_back_the_entire_transaction(self):
        db = sqlite3.connect(':memory:')
        db.execute('CREATE TABLE projects (id INTEGER, local_path TEXT, updated_at INTEGER)')
        db.executemany('INSERT INTO projects VALUES (?,?,0)', [(1, '/old/demo'), (2, '/old/other')])
        db.commit()
        with self.assertRaises(deploy.DeploymentError):
            deploy.rewrite_paths(db, [(1, '/old/demo', '/new/demo'), (2, '/changed/other', '/new/other')])
        self.assertEqual(db.execute('SELECT local_path FROM projects WHERE id=1').fetchone()[0], '/old/demo')
        self.assertEqual(deploy.rewrite_paths(db, [(1, '/old/demo', '/new/demo')]), 2)
        db.close()

    def test_environment_update_preserves_existing_secrets_without_returning_them_to_logs(self):
        original = b'GITHUB_TOKEN=keep-this-value\nPUBLIC_ORIGIN=https://dashboard.test:3020\nBROWSER_EDITOR_ORIGIN=https://old.test\n'
        result = deploy.browser_environment(original, 'https://editor.example.test')
        self.assertIn(b'GITHUB_TOKEN=keep-this-value\n', result)
        self.assertIn(b'PUBLIC_ORIGIN=https://dashboard.test:3020\n', result)
        self.assertEqual(result.count(b'BROWSER_EDITOR_ORIGIN='), 1)
        self.assertNotIn(b'https://old.test', result)

    def test_private_files_are_mode_600_and_database_backup_can_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            file = root / 'config'
            deploy.private_write(file, b'protected value')
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            source, backup = root / 'live.db', root / 'backup.db'
            db = sqlite3.connect(source)
            db.execute('CREATE TABLE settings (value TEXT)')
            db.execute('INSERT INTO settings VALUES (?)', ('original',))
            db.commit()
            db.close()
            deploy.backup_database(source, backup)
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
            db = sqlite3.connect(source)
            db.execute("UPDATE settings SET value='changed'")
            db.commit()
            db.close()
            deploy.restore_database(backup, source)
            db = sqlite3.connect(source)
            self.assertEqual(db.execute('SELECT value FROM settings').fetchone()[0], 'original')
            db.close()

    def test_command_output_is_not_written_into_the_operation_log(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'operations.log'
            runner = deploy.Runner(log)
            result = deploy.subprocess.CompletedProcess(['test'], 0, 'never-log-this-token', 'never-log-this-error')
            with patch.object(deploy.subprocess, 'run', return_value=result):
                self.assertEqual(runner.run(['test'], 'Example', cwd=directory), 'never-log-this-token')
            content = log.read_text()
            self.assertNotIn('never-log', content)
            self.assertIn('Example: exit 0', content)


if __name__ == '__main__':
    unittest.main()
