const fse = require('fs-extra');
const fs = require('fs');
const path = require('path');

const HEADER_SIZE = 4377; // length of the header
const HEADER_CHUNK_EOF = Buffer.alloc(HEADER_SIZE); // Empty header used for check if we reached the end

function isDirEmpty(dirname) {
  return fs.promises.readdir(dirname).then((files) => {
    return files.length === 0;
  });
}

function readFromBuffer(buffer, start, end) {
  const _buffer = buffer.slice(start, end);
  // Trim off the empty bytes
  return _buffer.slice(0, _buffer.indexOf(0x00)).toString();
}

function normalizeArchivePath(header) {
  const rawPath = path.posix.join(header.prefix || '', header.name || '');
  const trimmed = rawPath.replace(/\/+$/, '');

  if (!trimmed || trimmed === '.') {
    return '';
  }

  return trimmed;
}

async function skipBlock(fd, size) {
  let remaining = size;

  while (remaining > 0) {
    const bytesToRead = Math.min(remaining, 64 * 1024);
    const buffer = Buffer.alloc(bytesToRead);
    const data = await fd.read(buffer, 0, bytesToRead, null);

    if (data.bytesRead <= 0) {
      break;
    }

    remaining -= data.bytesRead;
  }
}

async function readHeader(fd) {
  const headerChunk = Buffer.alloc(HEADER_SIZE);
  await fd.read(headerChunk, 0, HEADER_SIZE, null);

  // Reached end of file
  if (Buffer.compare(headerChunk, HEADER_CHUNK_EOF) === 0) {
    return null;
  }

  const name = readFromBuffer(headerChunk, 0, 255);
  const size = parseInt(readFromBuffer(headerChunk, 255, 269), 10);
  const mTime = readFromBuffer(headerChunk, 269, 281);
  const prefix = readFromBuffer(headerChunk, 281, HEADER_SIZE);

  return {
    name,
    size,
    mTime,
    prefix,
  };
}

async function readBlockToFile(fd, header, outputPath) {
  const archivePath = normalizeArchivePath(header);

  if (!archivePath) {
    await skipBlock(fd, Number.isFinite(header.size) ? header.size : 0);
    return;
  }

  const outputFilePath = path.join(outputPath, archivePath);
  const isDirectoryEntry =
    header.size === 0 &&
    (
      (header.name && /\/$/.test(header.name)) ||
      (header.prefix && /\/$/.test(header.prefix))
    );

  if (isDirectoryEntry) {
    fse.ensureDirSync(outputFilePath);
    return;
  }

  fse.ensureDirSync(path.dirname(outputFilePath));
  const outputStream = fs.createWriteStream(outputFilePath);

  let totalBytesToRead = header.size;
  while (true) {
    let bytesToRead = 512;
    if (bytesToRead > totalBytesToRead) {
      bytesToRead = totalBytesToRead;
    }

    if (bytesToRead === 0) {
      break;
    }

    const buffer = Buffer.alloc(bytesToRead);
    const data = await fd.read(buffer, 0, bytesToRead, null);

    if (data.bytesRead <= 0) {
      break;
    }

    outputStream.write(buffer.subarray(0, data.bytesRead));

    totalBytesToRead -= data.bytesRead;
  }

  await new Promise((resolve, reject) => {
    outputStream.on('error', reject);
    outputStream.end(resolve);
  });
}

module.exports = async function wpExtract({
  inputFile: _inputFile,
  outputDir,
  onStart,
  onUpdate,
  onFinish,
  override,
}) {
  if (!fs.existsSync(_inputFile)) {
    throw new Error(
      `Input file at location "${_inputFile}" could not be found.`
    );
  }

  if (override) {
    // Ensure the output dir exists and is empty
    fse.emptyDirSync(outputDir);
  } else {
    if (fs.existsSync(outputDir) && !(await isDirEmpty(outputDir))) {
      throw new Error(
        `Output dir is not empty. Clear it first or use the --force option to override it.`
      );
    }
  }

  fse.ensureDirSync(outputDir);

  const inputFileStat = fs.statSync(_inputFile);
  const inputFile = await fs.promises.open(_inputFile, 'r');

  // Trigger onStart callback
  onStart(inputFileStat.size);

  let offset = 0;
  let countFiles = 0;

  while (true) {
    const header = await readHeader(inputFile);
    if (!header) {
      break;
    }

    await readBlockToFile(inputFile, header, outputDir);
    offset = offset + HEADER_SIZE + header.size;
    countFiles++;

    // Trigger onUpdate callback
    onUpdate(offset);
  }

  await inputFile.close();

  // Trigger onFinish callback
  onFinish(countFiles);
};
