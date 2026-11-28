// Official npm platform packages. Update the version and all six integrity pins together.
export const ARKCLI_VERSION = '1.0.70';
export const ARKCLI_PACKAGE = '@volcengine/ark-cli';
const integrity = {
  'linux-x64': 'HR4CO4q6ZM0awkThzdy/CGVi45jqw1ej+V37IcqLABleMLaoL4m3dfltMN83iqBl09AKP+hXrKpxM8TLosKFbA==',
  'linux-arm64': 'ltfrPa07+xrDXxA8fRECzIEUeUaqhFR4oDnWT2Jdpg796Cez7CZjRFoHDbo+elNXWyJviT4diC8hXgzdVJ1VQg==',
  'darwin-x64': 'P3MFTeF7taDwQrniNtugIyfwa1d8dcJLhsZISOM/G5b92tb1RkPiPyeNf0GRNnkON74U5ZsHAepBam9VzR09xA==',
  'darwin-arm64': 'k3Dwpl9ySJGOkxgJYH3mXT9wQO3HPuqXNyjW9u2/4eD+C+3I4t79ELSav7oRh2iIrruU7T+Zg4NfI5DTctqDtg==',
  'win32-x64': 'UBnFCxfQtaKCUoaxY8+HZlN1P6ZrMngPABI62bo8km7TFwxHOBs7TDNx8FApLC6Se6KEg9XIyUbUZyyKFTzsbw==',
  'win32-arm64': 'hw3ms0WT9Rc7yzQO9Xi0IlqijEIBR16kmM2xvHA7bw2fri/9HXq3I/0YTgMpRfxO57bIeeARIHwFvXNvPOc7aQ=='
};

export function arkCliRelease(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (!Object.hasOwn(integrity, target)) return null;
  const nativePlatform = platform === 'win32' ? 'windows' : platform;
  const legacyArch = arch === 'x64' ? 'amd64' : arch;
  const filename = `arkcli-${nativePlatform}-${legacyArch}${platform === 'win32' ? '.exe' : ''}`;
  const name = `${ARKCLI_PACKAGE}-${target}`;
  return {
    target, filename, name, version: ARKCLI_VERSION, sha512: integrity[target],
    url: `https://registry.npmjs.org/${name}/-/${name.split('/')[1]}-${ARKCLI_VERSION}.tgz`
  };
}
