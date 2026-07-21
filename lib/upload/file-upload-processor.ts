import { writeFile, mkdir, unlink } from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { initializeDatabase } from "@/lib/mysql"
import { processArchive } from "./archive-processor"
import { detectArchiveType } from "./archive-extractor"

export interface FileUploadResult {
  success: boolean
  details?: any
  error?: string
}

/**
 * Process file upload from File object (original method - backward compatible)
 */
export async function processFileUpload(
  file: File,
  sessionId: string,
  logWithBroadcast: (message: string, type?: "info" | "success" | "warning" | "error") => void,
  password?: string,
): Promise<FileUploadResult> {
  let uploadedFilePath: string | null = null

  try {
    await initializeDatabase()

    if (!detectArchiveType(file.name)) {
      return {
        success: false,
        error: "Only .zip, .7z, and .rar files are allowed",
      }
    }

    logWithBroadcast("📦 File received: " + file.name + " Size: " + file.size, "info")

    // Create uploads directory if it doesn't exist
    const uploadsDir = path.join(process.cwd(), "uploads")
    if (!existsSync(uploadsDir)) {
      await mkdir(uploadsDir, { recursive: true })
    }

    // SECURITY: Use UUID-based temporary filename to prevent path traversal and overwrites
    const { v4: uuidv4 } = await import("uuid")
    const safeBaseName = path.basename(file.name)
    const tempFileName = `${uuidv4()}_${safeBaseName}`

    // Save uploaded file temporarily
    const bytes = await file.arrayBuffer()
    const buffer = new Uint8Array(bytes)
    uploadedFilePath = path.join(uploadsDir, tempFileName)
    await writeFile(uploadedFilePath, buffer)

    // Process using the file path method (reuse logic)
    return await processFileUploadFromPath(
      uploadedFilePath,
      file.name,
      sessionId,
      logWithBroadcast,
      true, // deleteAfterProcessing = true (original behavior)
      password,
    )
  } catch (error) {
    logWithBroadcast("💥 Upload processing error:" + error, "error")

    // CLEANUP: Delete the uploaded archive file on error too
    if (uploadedFilePath) {
      try {
        await unlink(uploadedFilePath)
        logWithBroadcast(`🗑️ Cleaned up archive file after error: ${uploadedFilePath}`, "info")
      } catch (cleanupError) {
        logWithBroadcast(`⚠️ Failed to cleanup archive file after error: ${cleanupError}`, "warning")
      }
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Process file upload from file path (new method for chunked uploads)
 * This allows processing files that were assembled from chunks
 *
 * @param filePath - Path to the uploaded archive file on disk
 * @param fileName - Original file name
 * @param sessionId - Upload session ID
 * @param logWithBroadcast - Logging function
 * @param deleteAfterProcessing - Whether to delete the file after processing (default: false for chunked uploads)
 * @param password - Optional archive password (for encrypted zip/7z/rar files)
 */
export async function processFileUploadFromPath(
  filePath: string,
  fileName: string,
  sessionId: string,
  logWithBroadcast: (message: string, type?: "info" | "success" | "warning" | "error") => void,
  deleteAfterProcessing: boolean = false,
  password?: string,
): Promise<FileUploadResult> {
  try {
    await initializeDatabase()

    if (!detectArchiveType(fileName)) {
      return {
        success: false,
        error: "Only .zip, .7z, and .rar files are allowed",
      }
    }

    // Check if file exists
    if (!existsSync(filePath)) {
      return {
        success: false,
        error: "File not found at path: " + filePath,
      }
    }

    // Get file size for logging
    const { stat } = await import("fs/promises")
    const stats = await stat(filePath)
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2)

    // Generate unique upload batch ID
    const uploadBatch = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
    logWithBroadcast(`🆔 Upload batch ID: ${uploadBatch}`, "info")
    logWithBroadcast(`📦 Processing file: ${fileName} Size: ${fileSizeMB} MB`, "info")

    // Extraction is delegated to system CLI tools (7z / unrar), which write to disk
    // rather than loading the whole archive into memory - this works the same way
    // regardless of file size, so there's no separate small/large file path anymore.
    let processingResult
    try {
      processingResult = await processArchive(filePath, fileName, uploadBatch, logWithBroadcast, password)
      logWithBroadcast("✅ Archive processing completed successfully", "success")
    } catch (processError) {
      const errorMsg = processError instanceof Error ? processError.message : String(processError)
      logWithBroadcast(`❌ Archive processing failed: ${errorMsg}`, "error")
      // Preserve PASSWORD_REQUIRED / INCORRECT_PASSWORD sentinels unwrapped so callers can detect them
      throw errorMsg === "PASSWORD_REQUIRED" || errorMsg === "INCORRECT_PASSWORD"
        ? new Error(errorMsg)
        : new Error(`Archive processing failed: ${errorMsg}`)
    }

    // CLEANUP: Delete the uploaded archive file after successful processing (if requested)
    if (deleteAfterProcessing) {
      try {
        await unlink(filePath)
        logWithBroadcast(`🗑️ Cleaned up uploaded archive file: ${filePath}`, "info")
      } catch (cleanupError) {
        logWithBroadcast(`⚠️ Failed to cleanup archive file: ${cleanupError}`, "warning")
      }
    }

    return {
      success: true,
      details: processingResult,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logWithBroadcast(`💥 Upload processing error: ${errorMessage}`, "error")

    // CLEANUP: Delete the uploaded archive file on error too (if requested)
    if (deleteAfterProcessing) {
      try {
        await unlink(filePath)
        logWithBroadcast(`🗑️ Cleaned up archive file after error: ${filePath}`, "info")
      } catch (cleanupError) {
        logWithBroadcast(`⚠️ Failed to cleanup archive file after error: ${cleanupError}`, "warning")
      }
    }

    return {
      success: false,
      error: errorMessage,
    }
  }
}
