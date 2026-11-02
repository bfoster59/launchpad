#!/usr/bin/env python3
"""Read-only workspace inventory. Prints status and paths, never secret values.

Run as the normal Omarchy user: python scripts/audit-omarchy.py
Keep the resulting report private; it describes the host and local projects.
"""
import getpass
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import stat
import subprocess
from urllib.parse import quote


def command(args, timeout=8):
    env = os.environ.copy()
    env['GIT_OPTIONAL_LOCKS'] = '0'
    env.setdefault('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')
    env.setdefault('DBUS_SESSION_BUS_ADDRESS', f"unix:path=/run/user/{os.getuid()}/bus")
    try:
        result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=timeout)
        return result.stdout.strip() if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def unit(name, user=False):
    args = ['systemctl'] + (['--user'] if user else [])
    result = command(args + ['show', name, '-p', 'Id', '-p', 'ActiveState', '-p', 'UnitFileState', '-p', 'MainPID'])
    return dict(line.split('=', 1) for line in (result or '').splitlines() if '=' in line)


def http_status(port):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=4)
    try:
        connection.request('GET', '/')
        return connection.getresponse().status
    except OSError:
        return None
    finally:
        connection.close()


def repositories(root):
    result = []
    if not root.is_dir():
        return result
    for repo in sorted(root.iterdir()):
        if not repo.is_dir() or not (repo / '.git').exists():
            continue
        def git(*args):
            return command(['git', '--no-optional-locks', '-C', str(repo), *args])
        changes = git('status', '--porcelain=v1')
        tracking = git('rev-list', '--left-right', '--count', 'HEAD...@{upstream}')
        ahead, behind = map(int, tracking.split()) if tracking else (None, None)
        result.append({
            'path': str(repo), 'branch': git('symbolic-ref', '--short', 'HEAD'),
            'head': git('rev-parse', '--short', 'HEAD'),
            'changed_entries': len(changes.splitlines()) if changes is not None else None,
            'ahead': ahead, 'behind': behind,
            'worktrees': sum(line.startswith('worktree ') for line in (git('worktree', 'list', '--porcelain') or '').splitlines()),
        })
    return result


def launchpad_data(repo):
    database = repo / 'launchpad.db'
    if not database.is_file():
        return {'database_found': False}
    try:
        db = sqlite3.connect('file:' + quote(str(database), safe='/') + '?mode=ro', uri=True, timeout=3)
        try:
            settings = dict(db.execute("SELECT key,value FROM settings WHERE key IN ('clone_base_dir','scan_roots','terminal_app')"))
            projects = [{'id': row[0], 'name': row[1], 'local_path': row[2]} for row in db.execute('SELECT id,name,local_path FROM projects ORDER BY id')]
            github_stored = bool(db.execute("SELECT 1 FROM settings WHERE key='github_pat' AND length(value)>0").fetchone())
            return {'database_found': True, 'settings': settings, 'project_count': len(projects),
                    'github_credential_stored': github_stored, 'project_paths': projects}
        finally:
            db.close()
    except sqlite3.Error:
        return {'database_found': True, 'read_status': 'unavailable'}


def process_flags(pid):
    if not pid or not pid.isdigit() or int(pid) <= 0:
        return {'status': 'process unavailable'}
    try:
        raw = Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
        values = dict(entry.split(b'=', 1) for entry in raw if b'=' in entry)
        return {key: bool(values.get(key.encode())) for key in
                ['GITHUB_TOKEN', 'PUBLIC_ORIGIN', 'BROWSER_EDITOR_ORIGIN']}
    except OSError:
        return {'status': 'process environment unavailable'}


def editor_config():
    config = Path.home() / '.config/code-server/config.yaml'
    result = {'found': config.is_file()}
    if not config.is_file():
        return result
    result['permissions'] = oct(stat.S_IMODE(config.stat().st_mode))
    # Read only the two non-secret configuration fields; never emit other lines.
    for line in config.read_text().splitlines():
        key, separator, value = line.partition(':')
        key, value = key.strip(), value.strip()
        if separator and key == 'auth':
            result[key] = value if value in ('password', 'none') else 'unrecognized (value omitted)'
        elif separator and key == 'bind-addr':
            result[key] = value if re.fullmatch(r'[A-Za-z0-9.:[\]-]+', value) else 'unrecognized (value omitted)'
    return result


def main():
    user = getpass.getuser()
    if os.getuid() == 0:
        raise SystemExit('Run this audit as your normal Omarchy user, without sudo.')
    launchpad = unit('launchpad.service', user=True)
    report = {
        'hostname': socket.gethostname(), 'user': user,
        'work_mount': command(['findmnt', '--mountpoint', '/work', '-n', '-o', 'SOURCE,UUID,FSTYPE,TARGET']),
        'disk_space': command(['df', '-h', '/work']),
        'code_server_service': unit(f'code-server@{user}.service'),
        'launchpad_service': launchpad,
        'linger': command(['loginctl', 'show-user', user, '-p', 'Linger']),
        'local_http': {'code_server': http_status(8080), 'launchpad': http_status(3020)},
        'tailscale_serve': command(['tailscale', 'serve', 'status']),
        'editor_config': editor_config(),
        'launchpad_runtime_flags': process_flags(launchpad.get('MainPID')),
        'launchpad': launchpad_data(Path('/work/projects/launchpad')),
        'canonical_repositories': repositories(Path('/work/projects')),
        'old_repositories': repositories(Path.home() / 'github'),
        'tools': {name: shutil.which(name) for name in ['git', 'gh', 'claude', 'codex', 'gemini', 'code-server']},
        'authentication_note': 'CLI sign-ins and app API access require separate functional verification.',
    }
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
