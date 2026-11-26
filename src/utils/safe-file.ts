import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  constants,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Creates (or reuses) a data directory that only the current user can read. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to use ${dir}: it is not a regular directory.`);
  }
  try {
    // mkdirSync does not tighten a directory that already exists.
    chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    // Windows ignores most mode bits; best effort, as for files.
  }
}

/** Refuses to replace symlinks or special files. */
export function assertWritableTarget(target: string): void {
  if (!existsSync(target)) {
    return;
  }
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Refusing to write ${target}: it is a symbolic link. Remove the link first.`
    );
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing to write ${target}: it is not a regular file.`);
  }
}

/**
 * Writes text through a random temp file in the same directory, fsyncs it and
 * renames it over the target. The temp name is unpredictable and created with
 * O_EXCL and mode 0600, so a pre-planted symlink cannot redirect the write.
 */
export function atomicWritePrivate(target: string, text: string): void {
  ensurePrivateDir(dirname(target));
  assertWritableTarget(target);
  const temp = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", PRIVATE_FILE_MODE);
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, target);
    try {
      chmodSync(target, PRIVATE_FILE_MODE);
    } catch {
      // Windows ignores most mode bits; the file is still owner-only for new
      // files created by this process.
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed or unusable.
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may never have been created.
    }
    throw error;
  }
}

/** Reads a regular file only when it fits the given byte budget. */
export function readFileTextBounded(file: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    const before = lstatSync(file);
    if (before.isSymbolicLink()) {
      throw new Error(
        `${file} is a symbolic link; only regular files may be read.`
      );
    }
    if (!before.isFile()) {
      throw new Error(`${file} is not a regular file.`);
    }
    const noFollow = constants.O_NOFOLLOW ?? 0;
    fd = openSync(file, constants.O_RDONLY | noFollow);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.ino !== before.ino ||
      (before.dev !== 0 && stat.dev !== before.dev)
    ) {
      throw new Error(`${file} changed while it was being opened.`);
    }
    if (stat.size > maxBytes) {
      throw new Error(
        `${file} is too large (${stat.size} bytes); the limit is ${maxBytes} bytes.`
      );
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(fd, buffer, total, buffer.length - total, total);
      if (count === 0) break;
      total += count;
    }
    if (total > maxBytes) {
      throw new Error(
        `${file} is too large (more than ${maxBytes} bytes); the limit is ${maxBytes} bytes.`
      );
    }
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
