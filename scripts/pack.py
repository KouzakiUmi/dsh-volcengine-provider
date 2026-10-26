"""Build an npm-compatible tarball from the existing plugin build, without npm/install hooks."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'package.json').read_text(encoding='utf-8'))
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', default='artifacts', help='Output directory, relative to the source root unless absolute')
args = parser.parse_args()
output_dir = (root / args.output_dir).resolve()
output = output_dir / f"{manifest['name']}-{manifest['version']}.tgz"
checksum = output.with_suffix(output.suffix + '.sha256')
if output.exists() or checksum.exists():
    raise SystemExit(f'Will not overwrite an existing artifact or checksum: {output}')
files = [root / name for name in ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'NOTICE']]
for directory in ['lib', 'docs']:
    files.extend(sorted(path for path in (root / directory).rglob('*') if path.is_file()))
if not (root / 'lib' / 'index.mjs').is_file() or not (root / 'lib' / 'client.js').is_file():
    raise SystemExit('Build the plugin before packing')
for path in files:
    if path.is_symlink() or not path.resolve().is_relative_to(root):
        raise SystemExit('Refusing an unsafe package path')
output.parent.mkdir(parents=True, exist_ok=True)
def normalize_metadata(info):
    if info.name in {'package/lib/browser-bridge/linux/xdg-open', 'package/lib/browser-bridge/darwin/open'}:
        info.mode = 0o755
    return info


with output.open('xb') as stream:
    with tarfile.open(fileobj=stream, mode='w:gz') as archive:
        for path in files:
            archive.add(path, arcname='package/' + path.relative_to(root).as_posix(), recursive=False, filter=normalize_metadata)
with tarfile.open(output, 'r:gz') as archive:
    names = archive.getnames()
    assert 'package/package.json' in names and 'package/lib/index.mjs' in names
    assert not any('/.reference/' in name or '/test/' in name for name in names)
digest = hashlib.sha256(output.read_bytes()).hexdigest()
with checksum.open('x', encoding='utf-8', newline='\n') as stream:
    stream.write(f'{digest}  {output.name}\n')
print(f'Packed {len(files)} files: {output.name} ({output.stat().st_size} bytes)')
print('SHA256:', digest)
