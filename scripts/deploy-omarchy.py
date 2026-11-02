#!/usr/bin/env python3
"""Install the CI-verified browser workspace revision on the known Omarchy host.

Run as bfoster: python scripts/deploy-omarchy.py --apply --revision COMMIT --editor-origin HTTPS_ORIGIN
Keeps master unchanged, retains all original repositories, and skips growing.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import getpass
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
from urllib.parse import quote, urlsplit
import uuid

REPO = Path('/work/projects/launchpad')
BASE = '344df0ec406b80a04abcace19773a8fed212e332'
TARGET = None
BRANCH = 'fix/central-workspace-2026-11-01'
WORK_UUID = 'dd93f6db-69a8-443d-b313-44ca2fd60723'
EDITOR_ORIGIN = None
PUBLIC_ORIGIN = None


class DeploymentError(Exception):
    pass


def normalized_origin(value):
    try:
        parsed = urlsplit(value)
        valid_port = parsed.port  # Also validates syntax and range.
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or
                parsed.path not in ('', '/') or '?' in value or '#' in value):
            raise ValueError()
        return parsed.scheme + '://' + parsed.netloc
    except (ValueError, TypeError):
        raise DeploymentError('The editor and dashboard must use valid HTTPS origins without credentials or paths.') from None


def github_identity(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if value.startswith('git@github.com:'):
        path = value.split(':', 1)[1]
    else:
        try:
            parsed = urlsplit(value)
            if parsed.scheme not in ('http', 'https', 'ssh') or parsed.hostname != 'github.com' or parsed.query or parsed.fragment:
                return None
            path = parsed.path.lstrip('/')
        except ValueError:
            return None
    parts = path.rstrip('/').split('/')
    if len(parts) != 2:
        return None
    owner, repo = parts
    if repo.lower().endswith('.git'):
        repo = repo[:-4]
    if not all(re.fullmatch(r'[A-Za-z0-9_.-]+', part) for part in (owner, repo)):
        return None
    return f'{owner}/{repo}'.lower()


def private_write(path, data):
    fd, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def browser_environment(contents, editor_origin):
    # Preserve every other existing line, including all secret values.
    lines = contents.decode().splitlines()
    lines = [line for line in lines if not re.match(r'^\s*BROWSER_EDITOR_ORIGIN\s*=', line)]
    return ('\n'.join(lines) + '\nBROWSER_EDITOR_ORIGIN=' + normalized_origin(editor_origin) + '\n').encode()


def backup_database(source, destination):
    src = sqlite3.connect('file:' + quote(str(source), safe='/') + '?mode=ro', uri=True, timeout=10)
    dst = sqlite3.connect(destination)
    try:
        src.backup(dst)
        if dst.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise DeploymentError('Database backup integrity check failed.')
    finally:
        src.close()
        dst.close()
    os.chmod(destination, 0o600)


def restore_database(backup, destination):
    src = sqlite3.connect('file:' + quote(str(backup), safe='/') + '?mode=ro', uri=True)
    dst = sqlite3.connect(destination)
    try:
        src.backup(dst)
        if dst.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise DeploymentError('Database restore integrity check failed.')
    finally:
        src.close()
        dst.close()


def plan_paths(rows, old_root, canonical_root, identity_for):
    changes, held = [], []
    old_root, canonical_root = Path(old_root), Path(canonical_root)
    for project_id, name, old_path, repo_url in rows:
        if not old_path:
            continue
        path = Path(old_path)
        try:
            relative = path.relative_to(old_root)
        except ValueError:
            continue
        if len(relative.parts) != 1:
            held.append(project_id)
            continue
        # Both growing checkouts contain work on different branches. Do not pick
        # one on the user's behalf or alter either checkout during this install.
        if relative.name.casefold() == 'growing':
            held.append(project_id)
            continue
        destination = canonical_root / relative
        if path.is_symlink() or destination.is_symlink() or not destination.is_dir():
            raise DeploymentError(f'Project {project_id}: canonical directory is missing or indirect.')
        expected = github_identity(repo_url) or identity_for(path)
        if not expected or identity_for(path) != expected or identity_for(destination) != expected:
            raise DeploymentError(f'Project {project_id}: repository identities do not match.')
        changes.append((project_id, str(path), str(destination)))
    return changes, held


def rewrite_paths(database, changes):
    count = database.execute('SELECT count(*) FROM projects').fetchone()[0]
    database.execute('BEGIN IMMEDIATE')
    try:
        for project_id, old, new in changes:
            changed = database.execute('UPDATE projects SET local_path=?, updated_at=unixepoch() WHERE id=? AND local_path=?',
                                       (new, project_id, old)).rowcount
            if changed != 1:
                raise DeploymentError('A project path changed during preparation; stopped.')
        if database.execute('SELECT count(*) FROM projects').fetchone()[0] != count:
            raise DeploymentError('Project count changed unexpectedly.')
        database.commit()
    except BaseException:
        database.rollback()
        raise
    return count


def local_request(method, route, payload=None):
    connection = http.client.HTTPConnection('127.0.0.1', 3020, timeout=15)
    headers = {'Origin': PUBLIC_ORIGIN, 'Sec-Fetch-Site': 'same-origin'}
    body = None
    if payload is not None:
        body = json.dumps(payload)
        headers['Content-Type'] = 'application/json'
    try:
        connection.request(method, route, body, headers)
        response = connection.getresponse()
        raw = response.read()
        return response.status, json.loads(raw) if raw else None
    finally:
        connection.close()


class Runner:
    def __init__(self, log):
        self.log = log
        self.env = os.environ.copy()
        self.env['GIT_TERMINAL_PROMPT'] = '0'
        self.env['GIT_OPTIONAL_LOCKS'] = '0'
        self.env['XDG_RUNTIME_DIR'] = f'/run/user/{os.getuid()}'
        self.env['DBUS_SESSION_BUS_ADDRESS'] = f'unix:path=/run/user/{os.getuid()}/bus'
        self.build_env = self.env.copy()
        for key in ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']:
            self.build_env.pop(key, None)

    def run(self, args, label, cwd=REPO, build=False, timeout=60):
        try:
            result = subprocess.run(args, cwd=cwd, env=self.build_env if build else self.env,
                                    capture_output=True, text=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired):
            raise DeploymentError(label + ' could not complete; see the private backup/log directory.') from None
        with self.log.open('a') as log:
            # Never persist raw command output: remote URLs or a tool's error
            # could contain a credential even when we did not request one.
            log.write(label + ': exit ' + str(result.returncode) + '\n')
        if result.returncode:
            raise DeploymentError(label + f' failed (exit {result.returncode}); see the private log.')
        return result.stdout.strip()

    def git(self, *args):
        return self.run(['git', '-C', str(REPO), *args], 'Git ' + args[0])

    def service(self, action):
        return self.run(['systemctl', '--user', action, 'launchpad.service'], 'LaunchPad ' + action)


def deploy():
    global PUBLIC_ORIGIN
    if os.getuid() == 0 or getpass.getuser() != 'bfoster' or socket.gethostname() != 'matrix-og':
        raise DeploymentError('Run as bfoster on matrix-og, without sudo.')
    if REPO.is_symlink() or not (REPO / '.git').is_dir():
        raise DeploymentError('Expected canonical LaunchPad repository was not found.')
    state = Path.home() / '.local/state/omarchy'
    state.mkdir(parents=True, exist_ok=True)
    os.chmod(state, 0o700)
    lock = (state / 'deploy.lock').open('a')
    os.chmod(state / 'deploy.lock', 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise DeploymentError('Another Omarchy deployment is already running.') from None
    backup = Path(tempfile.mkdtemp(prefix='launchpad-backup-', dir=state))
    os.chmod(backup, 0o700)
    log = backup / 'deployment.log'
    log.touch(mode=0o600)
    run = Runner(log)
    env_path = Path.home() / '.config/launchpad/launchpad.env'
    database = REPO / 'launchpad.db'
    worktree = None
    live_changed = False
    database_backed_up = False
    old_branch = None
    print('Backup/log directory:', backup, flush=True)
    try:
        mount_uuid = run.run(['findmnt', '--mountpoint', '/work', '-n', '-o', 'UUID'], 'Work-drive identity')
        if mount_uuid != WORK_UUID:
            raise DeploymentError('Work-drive UUID does not match the verified drive.')
        if run.git('status', '--porcelain'):
            raise DeploymentError('LaunchPad has local changes. Nothing will be overwritten.')
        old_branch = run.git('branch', '--show-current')
        if old_branch != 'master' or run.git('rev-parse', 'HEAD') != BASE:
            raise DeploymentError('LaunchPad is not at the audited master revision; stopped for review.')
        if github_identity(run.git('config', '--get', 'remote.origin.url')) != 'bfoster59/launchpad':
            raise DeploymentError('LaunchPad origin does not match the expected repository.')
        properties = run.run(['systemctl', '--user', 'show', 'launchpad.service', '-p', 'WorkingDirectory', '-p', 'MainPID'], 'Service identity')
        properties = dict(line.split('=', 1) for line in properties.splitlines() if '=' in line)
        if properties.get('WorkingDirectory') != str(REPO):
            raise DeploymentError('LaunchPad service uses a different working directory; stopped.')
        pid = properties.get('MainPID', '0')
        if not pid.isdigit() or int(pid) <= 0:
            raise DeploymentError('LaunchPad is not running; stopped before changes.')
        process_env = dict(item.split(b'=', 1) for item in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in item)
        PUBLIC_ORIGIN = normalized_origin(process_env.get(b'PUBLIC_ORIGIN', b'').decode())
        actual_db = process_env.get(b'LAUNCHPAD_DB', b'').decode()
        if actual_db and (REPO / actual_db).resolve() != database.resolve():
            raise DeploymentError('LaunchPad uses a custom database path; stopped for review.')
        if not env_path.is_file() or env_path.is_symlink() or not database.is_file():
            raise DeploymentError('The expected environment file or database is missing or indirect.')
        if env_path.stat().st_uid != os.getuid() or env_path.stat().st_mode & 0o077:
            raise DeploymentError('LaunchPad environment permissions need review before deployment.')
        for source, name in [(env_path, 'launchpad.env'),
                (Path.home() / '.config/systemd/user/launchpad.service', 'launchpad.service'),
                (Path.home() / '.config/code-server/config.yaml', 'code-server-config.yaml'),
                (Path('/etc/fstab'), 'fstab')]:
            if source.is_file():
                private_write(backup / name, source.read_bytes())
        run.env.pop('BROWSER_EDITOR_ORIGIN', None)
        print('Preparing and testing the isolated code revision. Live services remain running.', flush=True)
        run.git('fetch', '--no-tags', 'origin', 'refs/heads/' + BRANCH)
        if run.git('rev-parse', TARGET + '^{commit}') != TARGET:
            raise DeploymentError('The CI-verified target revision is unavailable.')
        run.git('merge-base', '--is-ancestor', BASE, TARGET)
        run.git('merge-base', '--is-ancestor', TARGET, 'FETCH_HEAD')
        node = run.run(['/usr/bin/mise', 'exec', '--', 'node', '-p', 'process.execPath'], 'Node runtime selection')
        if not Path(node).is_absolute() or not Path(node).is_file():
            raise DeploymentError('The project Node executable could not be resolved.')
        version = run.run([node, '--version'], 'Node runtime version')
        if not version.startswith('v24.'):
            raise DeploymentError('This deployment requires the project Node 24 runtime.')
        run.build_env['PATH'] = str(Path(node).parent) + os.pathsep + run.build_env.get('PATH', '')
        worktree_root = Path('/work/worktrees')
        worktree_root.mkdir(exist_ok=True)
        worktree = worktree_root / ('launchpad-verify-' + uuid.uuid4().hex[:10])
        run.git('worktree', 'add', '--detach', str(worktree), TARGET)
        npm = str(Path(node).parent / 'npm')
        run.run([npm, 'ci', '--no-audit', '--no-fund'], 'Install isolated dependencies', cwd=worktree, build=True, timeout=600)
        run.run([npm, 'test'], 'Full Node test suite', cwd=worktree, build=True, timeout=300)
        run.run(['python', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*omarchy.py'],
                'Python audit/privacy suite', cwd=worktree, build=True, timeout=60)
        if run.git('status', '--porcelain') or run.git('rev-parse', 'HEAD') != BASE or run.git('branch', '--show-current') != old_branch:
            raise DeploymentError('LaunchPad changed during preparation; stopped before live changes.')
        print('Tests passed. Backing up and updating LaunchPad; brief dashboard downtime follows.', flush=True)
        run.service('stop')
        live_changed = True
        backup_database(database, backup / 'launchpad.db')
        database_backed_up = True
        def identity_for(path):
            return github_identity(run.run(['git', '-C', str(path), 'config', '--get', 'remote.origin.url'], 'Verify project origin'))
        db = sqlite3.connect(database, timeout=10)
        try:
            rows = db.execute('SELECT id,name,local_path,repo_url FROM projects ORDER BY id').fetchall()
            changes, held = plan_paths(rows, Path.home() / 'github', Path('/work/projects'), identity_for)
            count = rewrite_paths(db, changes)
        finally:
            db.close()
        private_write(backup / 'manifest.json', json.dumps({
            'original_branch': old_branch, 'original_commit': BASE, 'target_commit': TARGET,
            'project_count': count, 'path_changes': changes, 'held_project_ids': held,
            'created_utc': datetime.now(timezone.utc).isoformat(),
        }, indent=2).encode())
        deployed_branch = 'deployed/central-workspace-' + uuid.uuid4().hex[:10]
        run.git('switch', '--create', deployed_branch, TARGET)
        private_write(env_path, browser_environment((backup / 'launchpad.env').read_bytes(), EDITOR_ORIGIN))
        run.service('start')
        for attempt in range(30):
            try:
                status, settings = local_request('GET', '/api/settings')
                if status == 200:
                    break
            except (OSError, ValueError, http.client.HTTPException):
                pass
            time.sleep(0.5)
        else:
            raise DeploymentError('LaunchPad did not become ready after the update.')
        run.service('is-active')
        if not settings.get('github_pat', {}).get('set'):
            raise DeploymentError('The existing GitHub credential is not visible to LaunchPad after restart.')
        status, target = local_request('POST', '/api/util/open-terminal', {'path': '/work/projects/cncguy-edit'})
        if status != 200 or target.get('mode') != 'browser' or target.get('cwd') != '/work/projects/cncguy-edit':
            raise DeploymentError('Browser workspace route validation failed.')
        parsed = urlsplit(target['url'])
        if parsed.scheme + '://' + parsed.netloc != EDITOR_ORIGIN:
            raise DeploymentError('Browser workspace origin validation failed.')
        verify = sqlite3.connect('file:' + quote(str(database), safe='/') + '?mode=ro', uri=True)
        try:
            if verify.execute('SELECT count(*) FROM projects').fetchone()[0] != count:
                raise DeploymentError('Post-deployment project count validation failed.')
        finally:
            verify.close()
        github = 'not verified'
        try:
            status, response = local_request('POST', '/api/settings/test-github', {})
            github = 'verified' if status == 200 and response.get('ok') else 'needs separate attention'
        except (OSError, ValueError, http.client.HTTPException):
            github = 'needs separate attention'
        print('DEPLOYMENT PASSED', flush=True)
        print(f'Projects retained: {count}; stored paths corrected: {len(changes)}; held for preservation: {len(held)}')
        print('Browser workspace route: verified; GitHub connection:', github)
        print('growing: both checkouts retained; existing dashboard path preserved.')
        print('Live branch:', deployed_branch, '(master was not changed)')
        print('Private backup:', backup)
        print('Isolated verification worktree retained:', worktree)
        print('Hard-refresh LaunchPad, open CNCGuy Edit with Open in VS Code, then run pwd in its new terminal.')
    except BaseException as error:
        if live_changed:
            print('Restoring the previous LaunchPad state...', flush=True)
            try:
                run.service('stop')
                if database_backed_up:
                    restore_database(backup / 'launchpad.db', database)
                private_write(env_path, (backup / 'launchpad.env').read_bytes())
                if run.git('branch', '--show-current') != old_branch:
                    run.git('switch', old_branch)
                run.service('start')
                print('Previous service, database and environment restored.')
            except BaseException:
                print('Automatic restoration could not finish. Preserve the backup and report this result.')
        if isinstance(error, DeploymentError):
            print('STOPPED:', error)
        elif isinstance(error, KeyboardInterrupt):
            print('STOPPED: interrupted.')
        else:
            print('STOPPED: unexpected local error; details remain private. Report this result before continuing.')
        print('Private backup/log directory:', backup)
        return 1
    finally:
        lock.close()
    return 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Apply the tested deployment after all guards pass.')
    parser.add_argument('--revision', required=True, help='Full immutable commit SHA whose CI has passed.')
    parser.add_argument('--editor-origin', required=True, help='Existing private HTTPS code-server origin.')
    args = parser.parse_args()
    if not args.apply:
        parser.error('Use --apply when ready to install the CI-verified revision.')
    if not re.fullmatch(r'[0-9a-f]{40}', args.revision):
        parser.error('--revision must be a full lowercase commit SHA.')
    try:
        TARGET = args.revision
        EDITOR_ORIGIN = normalized_origin(args.editor_origin)
        raise SystemExit(deploy())
    except DeploymentError as error:
        raise SystemExit(str(error))
