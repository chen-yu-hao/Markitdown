const { copyFile, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const project = path.resolve(context.packager.projectDir);
  const outputRoot = path.resolve(project, context.packager.config.directories?.output ?? 'release');
  const output = path.resolve(context.appOutDir);
  const relative = path.relative(outputRoot, output);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing to write portable metadata outside the packaged application directory.');
  const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  const marker = { format: 1, portable: true, product: manifest.productName ?? manifest.name, version: manifest.version };
  await writeFile(path.join(output, 'portable.json'), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  for (const filename of ['THIRD_PARTY_LICENSES.txt', 'THIRD_PARTY_DEPENDENCIES.json', 'ThirdPartyNotices.md']) {
    await copyFile(path.join(project, 'resources', filename), path.join(output, filename));
  }
  await copyFile(path.join(project, 'README.md'), path.join(output, 'README.zh-CN.md'));
};
