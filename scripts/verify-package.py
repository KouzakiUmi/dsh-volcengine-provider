"""Verify a plugin tarball and checksum without extracting or running package code."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile


def verify_package(directory, tag=None):
    directory = Path(directory)
    packages = sorted(directory.glob('*.tgz'))
    if len(packages) != 1:
        raise ValueError('Expected exactly one plugin tarball')
    package = packages[0]
    digest = hashlib.sha256(package.read_bytes()).hexdigest()
    checksum = package.with_suffix(package.suffix + '.sha256')
    if checksum.read_text(encoding='utf-8').strip() != f'{digest}  {package.name}':
        raise ValueError('Checksum mismatch')
    with tarfile.open(package, 'r:gz') as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        if len(names) != len(set(names)):
            raise ValueError('Duplicate archive paths')
        for member in members:
            path = PurePosixPath(member.name)
            if not member.isfile() or path.is_absolute() or '..' in path.parts or not member.name.startswith('package/') or '\\' in member.name:
                raise ValueError('Unsafe archive path or entry type')
            if any(part in {'.git', '.reference', 'node_modules', 'test', 'test-output', 'accounts', 'identity_store'} for part in path.parts):
                raise ValueError('Development or credential directory included')
            if any(part.startswith('.env') or part.startswith('.credentials') for part in path.parts):
                raise ValueError('Credential file included')
            if member.name.endswith(('.js', '.mjs', '.json', '.md', '.yml')):
                text = archive.extractfile(member).read().decode('utf-8')
                if re.search(r'(?i)[a-z]:[\\/]Users[\\/][^\\/\s]+[\\/]', text):
                    raise ValueError('Development-machine path included')
        required = {'package/package.json', 'package/lib/index.mjs', 'package/lib/client.js', 'package/cordis.patch.yml', 'package/README.md', 'package/LICENSE', 'package/NOTICE'}
        if not required.issubset(names):
            raise ValueError('Required plugin files missing')
        manifest = json.load(archive.extractfile('package/package.json'))
        if manifest.get('license') != 'MIT':
            raise ValueError('Package license must be MIT')
        if manifest.get('name') != 'dsh-volcengine-provider':
            raise ValueError('Unexpected package identity')
        version = manifest.get('version')
        if not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', version):
            raise ValueError('Invalid package version')
        if package.name != f"{manifest['name']}-{version}.tgz":
            raise ValueError('Artifact name does not match manifest')
        if tag is not None and tag != f'v{version}':
            raise ValueError('Version tag does not match package version')
        for entry in [manifest.get('main'), manifest.get('exports', {}).get('./client'), manifest.get('dsh', {}).get('bundle', {}).get('patch')]:
            if not isinstance(entry, str) or not entry.startswith('./') or f'package/{entry[2:]}' not in names:
                raise ValueError('Manifest entry missing from archive')
    return {'file': package.name, 'version': version, 'sha256': digest, 'files': len(names)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory')
    parser.add_argument('--tag')
    args = parser.parse_args()
    try:
        print(json.dumps(verify_package(args.directory, args.tag), ensure_ascii=False))
    except (ValueError, OSError, tarfile.TarError) as error:
        parser.exit(1, f'Package verification failed: {error}\n')
