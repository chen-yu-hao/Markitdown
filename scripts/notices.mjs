import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legalName = /^(?:(?:licen[cs]es?|copying|notices?|copyright|ofl)(?:$|[._-])|third[-_ ]?party[-_ ]?(?:notices?|licen[cs]es?)(?:$|[._-]))/i;
const omittedDirectories = new Set(['node_modules', '.git', '.cache', 'coverage', 'test', 'tests', 'fixtures']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const portablePath = value => value.split(path.sep).join('/');

async function legalFiles(directory, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const name = path.join(relative, entry.name);
    if (entry.isDirectory() && !omittedDirectories.has(entry.name)) files.push(...await legalFiles(directory, name));
    else if (entry.isFile() && legalName.test(entry.name)) files.push(name);
  }
  return files.sort((a, b) => a.localeCompare(b, 'en'));
}

async function writeGenerated(filename, contents) {
  try { if (await readFile(filename, 'utf8') === contents) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, contents, 'utf8'); await rename(temporary, filename); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function generateNotices(root = projectRoot) {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lockBytes = await readFile(path.join(root, 'package-lock.json'));
  const lock = JSON.parse(lockBytes.toString('utf8'));
  if (!lock.packages) throw new Error('package-lock.json must use a packages-based npm lock format.');
  const installed = [];
  const omitted = [];
  const warnings = [];
  const supplements = [];
  const supplementDirectory = path.join(root, 'resources', 'native-licenses');
  async function readSupplements(relative = '') {
    for (const entry of await readdir(path.join(supplementDirectory, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const filename = path.join(relative, entry.name);
      if (entry.isDirectory()) await readSupplements(filename);
      else if (entry.isFile() && /\.(?:txt|md|json)$/i.test(entry.name)) {
        const bytes = await readFile(path.join(supplementDirectory, filename));
        supplements.push({ path: `resources/native-licenses/${portablePath(filename)}`, sha256: digest(bytes), bytes: bytes.length, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
      }
    }
  }
  try { await readSupplements(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  supplements.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const provenanceText = supplements.find(file => file.path === 'resources/native-licenses/provenance.json')?.text;
  const nativeProvenance = provenanceText ? JSON.parse(provenanceText) : null;
  if (nativeProvenance) {
    if (nativeProvenance.schemaVersion !== 1 || !Array.isArray(nativeProvenance.files)) throw new Error('Unsupported native license provenance format.');
    for (const evidence of nativeProvenance.files) {
      const supplement = supplements.find(file => file.path === `resources/native-licenses/${evidence.file}`);
      if (!supplement || supplement.sha256 !== evidence.sha256) throw new Error(`Native legal material differs from its recorded source: ${evidence.file}`);
    }
    const binary = nativeProvenance.upstreamArchive?.verifiedDll;
    if (binary) {
      const installedPath = path.resolve(root, binary.installedPath);
      const relative = path.relative(path.join(root, 'node_modules'), installedPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid native binary provenance path.');
      if (digest(await readFile(installedPath)) !== binary.sha256) throw new Error('The native library changed; reverify its legal provenance before packaging.');
    }
  }
  const packageEvidence = supplements.filter(file => /-provenance\.json$/.test(file.path)).map(file => ({ path: file.path, evidence: JSON.parse(file.text) }));
  for (const { evidence } of packageEvidence) {
    if (evidence.schemaVersion !== 1 || typeof evidence.package !== 'string' || typeof evidence.packageVersion !== 'string' || !Array.isArray(evidence.files)) throw new Error('Unsupported supplemental package license provenance format.');
    for (const file of evidence.files) {
      const supplement = supplements.find(item => item.path === `resources/native-licenses/${file.file}`);
      if (!supplement || supplement.sha256 !== file.sha256) throw new Error(`Supplemental package legal material differs from its recorded source: ${file.file}`);
    }
    if (evidence.sourceArchive) {
      const filename = path.resolve(root, evidence.sourceArchive.path);
      const relative = path.relative(path.join(root, 'resources'), filename);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid supplemental source archive path.');
      if (digest(await readFile(filename)) !== evidence.sourceArchive.sha256) throw new Error(`Supplemental source archive differs from its recorded source: ${evidence.package}`);
    }
  }
  const packagePaths = new Set(Object.entries(lock.packages).filter(([name, value]) => name && !value.dev).map(([name]) => name));
  packagePaths.add('node_modules/electron');
  for (const location of [...packagePaths].sort()) {
    const absolute = path.resolve(root, location);
    const relative = path.relative(path.join(root, 'node_modules'), absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Invalid lockfile package location: ${location}`);
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(absolute, 'package.json'), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT' && lock.packages[location]?.optional) { omitted.push({ location, reason: 'Optional package not installed for this platform.' }); continue; }
      throw new Error(`Cannot read installed dependency ${location}. Run npm ci first.`, { cause: error });
    }
    const expected = lock.packages[location]?.version;
    if (expected && manifest.version !== expected) throw new Error(`Installed ${manifest.name} ${manifest.version} does not match locked ${expected}. Run npm ci.`);
    if (nativeProvenance?.package === manifest.name && nativeProvenance.packageVersion !== manifest.version) throw new Error('Native legal provenance does not match the installed package version.');
    const license = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? (Array.isArray(manifest.licenses) ? manifest.licenses.map(item => item.type).join(' OR ') : 'UNDECLARED');
    const record = {
      name: manifest.name, version: manifest.version, location, license,
      repository: typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url ?? null,
      homepage: typeof manifest.homepage === 'string' ? manifest.homepage : null,
      licenseFiles: [], warnings: [],
    };
    const texts = [];
    for (const filename of await legalFiles(absolute)) {
      // Chromium's complete HTML notices are already shipped beside the executable.
      if (manifest.name === 'electron' && path.basename(filename) === 'LICENSES.chromium.html') {
        record.bundledRuntimeNotices = ['LICENSES.chromium.html'];
        continue;
      }
      const bytes = await readFile(path.join(absolute, filename));
      record.licenseFiles.push({ path: portablePath(filename), sha256: digest(bytes), bytes: bytes.length });
      texts.push({ path: portablePath(filename), text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
    }
    const supplemental = packageEvidence.find(item => item.evidence.package === manifest.name);
    if (supplemental) {
      if (supplemental.evidence.packageVersion !== manifest.version) throw new Error(`Supplemental legal provenance does not match ${manifest.name}@${manifest.version}.`);
      record.supplementalProvenance = supplemental.path;
      if (supplemental.evidence.sourceLicenseDeclaration) record.sourceLicenseDeclaration = supplemental.evidence.sourceLicenseDeclaration;
      if (supplemental.evidence.selectedLicense) record.distributionLicense = supplemental.evidence.selectedLicense;
      if (supplemental.evidence.sourceArchive) record.sourceArchive = supplemental.evidence.sourceArchive;
      if (supplemental.evidence.licenseMetadataNote) record.warnings.push(supplemental.evidence.licenseMetadataNote);
      for (const evidence of supplemental.evidence.installedFiles || []) {
        const filename = path.resolve(absolute, evidence.file);
        const relative = path.relative(absolute, filename);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid supplemental installed-file provenance path.');
        if (digest(await readFile(filename)) !== evidence.sha256) throw new Error(`Installed file differs from its recorded legal source: ${manifest.name}/${evidence.file}`);
      }
    }
    if (record.licenseFiles.length === 0) record.warnings.push(supplemental
      ? `The installed package omits legal notice files. Supplemental upstream attribution and license text are included; see ${supplemental.path} for exact source and scope.`
      : 'No legal notice file was found in the installed package.');
    if (license === 'UNDECLARED') record.warnings.push('The package does not declare a license; no default license has been assigned.');
    if (manifest.name.startsWith('@img/sharp-')) {
      try { record.nativeComponentVersions = JSON.parse(await readFile(path.join(absolute, 'versions.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (nativeProvenance?.package === manifest.name) record.supplementalProvenance = 'resources/native-licenses/provenance.json';
      if (/LGPL/.test(license) && !texts.some(file => /GNU LESSER GENERAL PUBLIC LICENSE/i.test(file.text))) {
        record.warnings.push(supplements.some(file => /GNU LESSER GENERAL PUBLIC LICENSE/i.test(file.text))
          ? 'The installed package omits its declared LGPL text. Supplemental upstream legal materials are included; see their provenance for exact component coverage.'
          : 'The declared LGPL license text is absent from the installed legal files. Native component license completeness needs upstream verification.');
      }
    }
    warnings.push(...record.warnings.map(warning => `${record.name}@${record.version}: ${warning}`));
    installed.push({ record, texts });
  }
  const lockHash = digest(lockBytes);
  const lines = [
    `${packageJson.productName ?? packageJson.name} ${packageJson.version} - Third-party license texts`,
    `Generated from package-lock.json SHA-256: ${lockHash}`,
    `Build platform: ${process.platform}-${process.arch}`,
    'Includes installed production npm dependencies and the Electron runtime package.',
    'Optional packages absent from this platform are listed in THIRD_PARTY_DEPENDENCIES.json.',
    'Electron/Chromium runtime notices also ship as LICENSE.electron.txt (or LICENSE) and LICENSES.chromium.html.',
    'License expressions are package declarations. Original legal texts below are preserved without substituting a default license.',
    '',
  ];
  if (warnings.length) lines.push('Verification notes:', ...warnings.map(warning => `- ${warning}`), '');
  for (const { record, texts } of installed) {
    lines.push('='.repeat(80), `${record.name}@${record.version}`, `Package: ${record.location}`, `Declared license: ${record.license}`, `Repository: ${record.repository ?? '(not declared)'}`);
    if (record.sourceLicenseDeclaration) lines.push(`Source license declaration: ${record.sourceLicenseDeclaration}`);
    if (record.distributionLicense) lines.push(`License option used for this component: ${record.distributionLicense}`);
    if (record.sourceArchive) lines.push(`Bundled component source: ${record.sourceArchive.path}`, `Source archive SHA-256: ${record.sourceArchive.sha256}`);
    if (record.homepage) lines.push(`Homepage: ${record.homepage}`);
    if (record.nativeComponentVersions) lines.push(`Native component versions: ${JSON.stringify(record.nativeComponentVersions)}`);
    for (const warning of record.warnings) lines.push(`Verification note: ${warning}`);
    for (const file of texts) lines.push('', `----- ${file.path} -----`, file.text);
    lines.push('');
  }
  if (supplements.length) {
    lines.push('='.repeat(80), 'Supplemental dependency legal materials', 'The provenance in these materials defines their exact version and component scope.', '');
    for (const file of supplements) lines.push(`----- ${file.path} -----`, `SHA-256: ${file.sha256}`, '', file.text, '');
  }
  const manifest = {
    product: packageJson.productName ?? packageJson.name, version: packageJson.version,
    platform: process.platform, architecture: process.arch, packageLockSha256: lockHash,
    packages: installed.map(item => item.record), omittedOptionalPackages: omitted,
    supplementalFiles: supplements.map(({ text: _text, ...file }) => file), warnings,
    nativeLicenseEvidence: nativeProvenance,
    supplementalPackageLicenseEvidence: packageEvidence,
  };
  const resources = path.join(root, 'resources');
  await mkdir(resources, { recursive: true });
  await writeGenerated(path.join(resources, 'THIRD_PARTY_LICENSES.txt'), lines.join('\n'));
  await writeGenerated(path.join(resources, 'THIRD_PARTY_DEPENDENCIES.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { packages: installed.length, licenseFiles: installed.reduce((sum, item) => sum + item.record.licenseFiles.length, 0), supplementalFiles: supplements.length, warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await generateNotices();
  console.log(`Collected ${result.licenseFiles} legal files from ${result.packages} installed runtime dependencies and ${result.supplementalFiles} supplemental files.`);
  for (const warning of result.warnings) console.warn(`Notice: ${warning}`);
}
