import { spawn } from "child_process"
import { mkdir, readdir } from "fs/promises"
import path from "path"

export type ArchiveType = "zip" | "7z" | "rar"

const EXTRACTION_TIMEOUT_MS = 30 * 60 * 1000 // generous ceiling for very large archives
const MAX_OUTPUT_CHARS = 8 * 1024 * 1024 // cap captured stdout/stderr to avoid unbounded memory use

export function detectArchiveType(fileName: string): ArchiveType | null {
  const lower = fileName.toLowerCase()
  if (lower.endsWith(".zip")) return "zip"
  if (lower.endsWith(".7z")) return "7z"
  if (lower.endsWith(".rar")) return "rar"
  return null
}

function isPasswordFailure(output: string): boolean {
  const lower = output.toLowerCase()
  return (
    lower.includes("wrong password") ||
    lower.includes("incorrect password") ||
    lower.includes("cannot open encrypted archive")
  )
}

function runCommand(command: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    let child
    try {
      // stdin is explicitly closed ("ignore") so 7z/unrar never hang waiting for an
      // interactive password prompt - they fail immediately instead.
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    } catch (err) {
      reject(err)
      return
    }

    let output = ""
    let truncated = false
    const collect = (chunk: Buffer) => {
      if (truncated) return
      output += chunk.toString("utf8")
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS)
        truncated = true
      }
    }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)

    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`${command} timed out after ${EXTRACTION_TIMEOUT_MS / 1000}s`))
    }, EXTRACTION_TIMEOUT_MS)

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (err.code === "ENOENT") {
        reject(new Error(`Required archive tool "${command}" is not installed on the server`))
      } else {
        reject(err)
      }
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

/**
 * Extract a .zip/.7z/.rar archive to destDir using system CLI tools (7z / unrar).
 * These tools support classic ZipCrypto AND modern AES-256 encryption (zip/7z), as well
 * as RAR's native encryption - unlike the pure-JS libraries (JSZip, adm-zip) this app
 * used to rely on, which only handle unencrypted or ZipCrypto-only zip files.
 *
 * Throws "PASSWORD_REQUIRED" or "INCORRECT_PASSWORD" sentinel errors when relevant.
 */
export async function extractArchive(
  filePath: string,
  destDir: string,
  archiveType: ArchiveType,
  password: string | undefined,
): Promise<void> {
  await mkdir(destDir, { recursive: true })

  let result: { code: number | null; output: string }
  if (archiveType === "rar") {
    // -p- explicitly disables the interactive password prompt when no password is given
    const passwordArg = password ? `-p${password}` : "-p-"
    result = await runCommand("unrar", ["x", "-y", passwordArg, filePath, `${destDir}${path.sep}`])
  } else {
    // 7z handles both .zip and .7z; an empty -p still lets it fail deterministically
    // instead of prompting when the archive turns out to be encrypted.
    const passwordArg = `-p${password ?? ""}`
    result = await runCommand("7z", ["x", "-y", passwordArg, `-o${destDir}`, filePath])
  }

  if (result.code === 0) return

  if (isPasswordFailure(result.output)) {
    throw new Error(password ? "INCORRECT_PASSWORD" : "PASSWORD_REQUIRED")
  }

  throw new Error(`Archive extraction failed (exit ${result.code}): ${result.output.trim().slice(-2000)}`)
}

export interface ExtractedFile {
  relPath: string
  absPath: string
  isDir: boolean
}

/**
 * Recursively list files extracted to rootDir, returning paths relative to rootDir
 * (posix-style, forward slashes) so the rest of the pipeline can treat them the same
 * way regardless of the source archive format.
 *
 * Symlinks are skipped (not followed, not listed) as defense-in-depth: an archive
 * could otherwise contain a symlink pointing outside the extraction directory.
 */
export async function listExtractedFiles(rootDir: string): Promise<ExtractedFile[]> {
  const results: ExtractedFile[] = []
  const resolvedRoot = path.resolve(rootDir)

  async function walk(currentDir: string) {
    const entries = await readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const absPath = path.join(currentDir, entry.name)
      const resolvedAbsPath = path.resolve(absPath)

      // SECURITY: defense-in-depth against zip-slip / path traversal
      if (resolvedAbsPath !== resolvedRoot && !resolvedAbsPath.startsWith(resolvedRoot + path.sep)) {
        continue
      }

      const relPath = path.relative(resolvedRoot, resolvedAbsPath).split(path.sep).join("/")

      if (entry.isDirectory()) {
        results.push({ relPath, absPath, isDir: true })
        await walk(absPath)
      } else if (entry.isFile()) {
        results.push({ relPath, absPath, isDir: false })
      }
      // symlinks (entry.isSymbolicLink()) are intentionally skipped
    }
  }

  await walk(rootDir)
  return results
}
