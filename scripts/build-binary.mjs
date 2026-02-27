import { build } from 'esbuild';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const distDir = join(rootDir, 'dist');

const bundlePath = join(distDir, 'cli.bundle.cjs');
const blobPath = join(distDir, 'sea-prep.blob');
const seaConfigPath = join(distDir, 'sea-config.json');

const binaryName = process.platform === 'win32' ? 'wpress-extract2.exe' : 'wpress-extract2';
const binaryPath = join(distDir, binaryName);

const seaConfig = {
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
};

const SEA_SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        stdio: 'inherit',
        cwd: rootDir,
        ...options,
    });

    if (result.status !== 0 && !options.allowFailure) {
        throw new Error(`Command failed: ${command} ${args.join(' ')}`);
    }
}

function getPostjectBinaryPath() {
    const executable = process.platform === 'win32' ? 'postject.cmd' : 'postject';
    return join(rootDir, 'node_modules', '.bin', executable);
}

await mkdir(distDir, { recursive: true });

await build({
    entryPoints: [join(rootDir, 'cli.js')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
});

await writeFile(seaConfigPath, `${JSON.stringify(seaConfig, null, 2)}\n`, 'utf8');

run(process.execPath, ['--experimental-sea-config', seaConfigPath]);
await copyFile(process.execPath, binaryPath);

if (process.platform !== 'win32') {
    await chmod(binaryPath, 0o755);
}

if (process.platform === 'darwin') {
    run('codesign', ['--remove-signature', binaryPath], { allowFailure: true });
}

const postjectArgs = [
    binaryPath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    SEA_SENTINEL,
];

if (process.platform === 'darwin') {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA');
}

run(getPostjectBinaryPath(), postjectArgs);

console.log(`Built SEA binary: ${binaryPath}`);