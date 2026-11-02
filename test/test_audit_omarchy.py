import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('audit', Path(__file__).parents[1] / 'scripts/audit-omarchy.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class AuditPrivacyTests(unittest.TestCase):
    def test_database_reads_only_paths_and_safe_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            db = sqlite3.connect(repo / 'launchpad.db')
            db.executescript('CREATE TABLE settings (key TEXT, value TEXT); CREATE TABLE projects (id INTEGER, name TEXT, local_path TEXT);')
            db.execute('INSERT INTO settings VALUES (?,?)', ('github_pat', 'test-secret-do-not-return'))
            db.execute('INSERT INTO settings VALUES (?,?)', ('anthropic_api_key', 'another-secret-do-not-return'))
            db.execute('INSERT INTO settings VALUES (?,?)', ('clone_base_dir', '/work/projects'))
            db.execute('INSERT INTO projects VALUES (1,?,?)', ('demo', '/work/projects/demo'))
            db.commit()
            db.close()
            result = audit.launchpad_data(repo)
            self.assertTrue(result['github_credential_stored'])
            self.assertEqual(result['project_count'], 1)
            self.assertEqual(result['settings'], {'clone_base_dir': '/work/projects'})
            self.assertNotIn('test-secret', json.dumps(result))
            self.assertNotIn('another-secret', json.dumps(result))

    def test_editor_password_and_unknown_auth_values_are_not_returned(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / '.config/code-server/config.yaml'
            config.parent.mkdir(parents=True)
            config.write_text('bind-addr: 127.0.0.1:8080\nauth: password\npassword: never-return-this\n')
            with patch.object(audit.Path, 'home', return_value=Path(directory)):
                result = audit.editor_config()
                self.assertEqual(result['auth'], 'password')
                self.assertNotIn('never-return-this', json.dumps(result))
                config.write_text('auth: unexpected-secret\nbind-addr: https://user:secret@example.test\n')
                result = audit.editor_config()
                self.assertNotIn('unexpected-secret', json.dumps(result))
                self.assertNotIn('user:secret', json.dumps(result))

    def test_process_environment_reports_only_presence(self):
        with patch.object(audit.Path, 'read_bytes', return_value=b'GITHUB_TOKEN=never-return-this\0PUBLIC_ORIGIN=https://private.example.test\0'):
            result = audit.process_flags('123')
            self.assertTrue(result['GITHUB_TOKEN'])
            self.assertTrue(result['PUBLIC_ORIGIN'])
            self.assertFalse(result['BROWSER_EDITOR_ORIGIN'])
            self.assertNotIn('never-return-this', json.dumps(result))

    def test_unavailable_repository_status_is_not_reported_as_clean(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'demo/.git').mkdir(parents=True)
            with patch.object(audit, 'command', return_value=None):
                result = audit.repositories(root)
            self.assertIsNone(result[0]['changed_entries'])
            self.assertIsNone(result[0]['ahead'])


if __name__ == '__main__':
    unittest.main()
