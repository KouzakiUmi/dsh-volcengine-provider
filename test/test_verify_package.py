"""Archive checks use synthetic packages only; no installation or real credentials."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('verify_package', Path(__file__).resolve().parents[1] / 'scripts' / 'verify-package.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class VerifyPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dsh-archive-test-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def fixture(self, extra=None, remove=None, modes=None):
        manifest = {
            'name': 'dsh-volcengine-provider', 'version': '0.1.0', 'main': './lib/index.mjs', 'license': 'MIT',
            'exports': {'./client': './lib/client.js'}, 'dsh': {'bundle': {'patch': './cordis.patch.yml'}}
        }
        files = {'package/package.json': json.dumps(manifest), 'package/lib/index.mjs': 'export const name = "fixture";', 'package/lib/client.js': '// fixture', 'package/lib/catalog-snapshot.json': '{}', 'package/lib/consumption-rates.json': '{}', 'package/cordis.patch.yml': '[]', 'package/README.md': '# Fixture', 'package/LICENSE': 'MIT fixture', 'package/NOTICE': 'fixture'}
        if extra:
            files.update(extra)
        if remove:
            del files[remove]
        package = self.directory / 'dsh-volcengine-provider-0.1.0.tgz'
        with tarfile.open(package, 'w:gz') as archive:
            for name, text in files.items():
                payload = text.encode('utf-8')
                info = tarfile.TarInfo(name)
                info.size = len(payload)
                if modes and name in modes:
                    info.mode = modes[name]
                archive.addfile(info, io.BytesIO(payload))
        checksum = package.with_suffix('.tgz.sha256')
        checksum.write_text(f'{hashlib.sha256(package.read_bytes()).hexdigest()}  {package.name}\n', encoding='utf-8')
        return package

    def test_valid_package(self):
        self.fixture()
        result = module.verify_package(self.directory, 'v0.1.0')
        self.assertEqual(result['version'], '0.1.0')
        self.assertEqual(result['files'], 9)

    def test_mismatched_tag(self):
        self.fixture()
        with self.assertRaisesRegex(ValueError, 'tag'):
            module.verify_package(self.directory, 'v9.9.9')

    def test_wrong_checksum(self):
        package = self.fixture()
        package.with_suffix('.tgz.sha256').write_text('incorrect', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Checksum'):
            module.verify_package(self.directory)

    def test_unsafe_archive_path(self):
        self.fixture({'package/../escape.txt': 'not extracted'})
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            module.verify_package(self.directory)

    def test_credential_file(self):
        self.fixture({'package/.credentials.yaml': 'fixture: [REDACTED]'})
        with self.assertRaisesRegex(ValueError, 'Credential'):
            module.verify_package(self.directory)

    def test_missing_entry(self):
        self.fixture(remove='package/lib/client.js')
        with self.assertRaisesRegex(ValueError, 'missing'):
            module.verify_package(self.directory)

    def test_missing_runtime_snapshot(self):
        self.fixture(remove='package/lib/consumption-rates.json')
        with self.assertRaisesRegex(ValueError, 'missing'):
            module.verify_package(self.directory)

    def test_browser_bridge_requires_all_platform_helpers(self):
        self.fixture({'package/lib/browser-bridge.mjs': '// fixture'})
        with self.assertRaisesRegex(ValueError, 'Browser bridge files missing'):
            module.verify_package(self.directory)

    def test_browser_bridge_opener_must_be_executable(self):
        self.fixture({'package/lib/browser-bridge/linux/xdg-open': '#!/bin/sh\n'})
        with self.assertRaisesRegex(ValueError, 'executable'):
            module.verify_package(self.directory)

    def test_complete_browser_bridge_with_executable_openers(self):
        files = {'package/lib/browser-bridge.mjs': '// fixture', 'package/lib/browser-bridge-client.mjs': '// fixture', 'package/lib/browser-bridge/win32/rundll32.exe': 'native fixture', 'package/lib/browser-bridge/linux/xdg-open': '#!/bin/sh\n', 'package/lib/browser-bridge/darwin/open': '#!/bin/sh\n'}
        modes = {name: 0o755 for name in files if name.endswith(('/xdg-open', '/open'))}
        self.fixture(files, modes=modes)
        self.assertEqual(module.verify_package(self.directory)['files'], 14)

    def test_development_directory(self):
        self.fixture({'package/test/unwanted.mjs': '// fixture'})
        with self.assertRaisesRegex(ValueError, 'Development'):
            module.verify_package(self.directory)


if __name__ == '__main__':
    unittest.main()
