import { mkdir, rm, readFile } from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { executeQuery } from "@/lib/mysql"
import crypto from "crypto"
import { detectArchiveType, extractArchive, listExtractedFiles } from "./archive-extractor"
import { analyzeZipStructureFromPaths, extractDeviceNameWithMacOSSupport, type ZipStructureInfo } from "./zip-structure-analyzer"
import { processDevice, type DeviceProcessingResult } from "./device-processor"
import { checkMonitorsForBatch } from "@/lib/domain-monitor"

export interface ProcessingResult {
  devicesFound: number
  devicesProcessed: number
  devicesSkipped: number
  totalFiles: number
  totalCredentials: number
  totalDomains: number
  totalUrls: number
  totalBinaryFiles: number
  uploadBatch: string
  processedDevices: string[]
  skippedDevices: string[]
  structureInfo: ZipStructureInfo
}

// Adapts a file extracted to disk to the {dir, async(format)} interface device-processor.ts expects
class DiskEntryWrapper {
  public dir = false

  constructor(private absPath: string) {}

  async async(format: "text" | "uint8array"): Promise<string | Uint8Array> {
    if (format === "text") {
      return await readFile(this.absPath, "utf8")
    }
    return new Uint8Array(await readFile(this.absPath))
  }
}

/**
 * Extract and process a .zip/.7z/.rar archive (optionally password-protected).
 * Extraction is delegated to system CLI tools (7z / unrar) which write directly to
 * disk, so this works uniformly for archives of any size without loading them into
 * Node's memory.
 */
export async function processArchive(
  filePath: string,
  fileName: string,
  uploadBatch: string,
  logWithBroadcast: (message: string, type?: "info" | "success" | "warning" | "error") => void,
  password?: string,
): Promise<ProcessingResult> {
  const archiveType = detectArchiveType(fileName)
  if (!archiveType) {
    throw new Error("Unsupported archive type. Only .zip, .7z, and .rar files are supported.")
  }

  const today = new Date().toISOString().split("T")[0]
  const extractionBaseDir = path.join(process.cwd(), "uploads", "extracted_files", today, uploadBatch)
  const rawExtractDir = path.join(extractionBaseDir, "_raw_extract")

  try {
    if (!existsSync(extractionBaseDir)) {
      await mkdir(extractionBaseDir, { recursive: true })
    }

    logWithBroadcast(`📦 Extracting ${archiveType.toUpperCase()} archive: ${fileName}`, "info")
    try {
      await extractArchive(filePath, rawExtractDir, archiveType, password)
      logWithBroadcast("✅ Archive extracted successfully", "success")
    } catch (extractError) {
      const msg = extractError instanceof Error ? extractError.message : String(extractError)
      if (msg === "PASSWORD_REQUIRED") {
        logWithBroadcast("🔒 Archive is password-protected, no password provided", "warning")
      } else if (msg === "INCORRECT_PASSWORD") {
        logWithBroadcast("❌ Incorrect password provided for encrypted archive", "error")
      } else {
        logWithBroadcast(`❌ Failed to extract archive: ${msg}`, "error")
      }
      throw extractError
    }

    logWithBroadcast("🔍 Scanning extracted files...", "info")
    const extractedFiles = await listExtractedFiles(rawExtractDir)
    const entryByRelPath = new Map(extractedFiles.map((f) => [f.relPath, f]))
    const allPaths = extractedFiles.filter((f) => !f.isDir).map((f) => f.relPath)
    logWithBroadcast(`✅ Found ${allPaths.length} files`, "success")

    const structureInfo = analyzeZipStructureFromPaths(allPaths)
    logWithBroadcast(`🧠 Structure Analysis: ${JSON.stringify(structureInfo)}`, "info")
    logWithBroadcast(`🍎 macOS archive detected: ${structureInfo.macOSDetected}`, "info")

    // Group files by device
    const deviceMap = new Map<string, Array<{ path: string; entry: DiskEntryWrapper }>>()
    let entryCount = 0

    for (const relPath of allPaths) {
      entryCount++
      if (entryCount % 1000 === 0) {
        logWithBroadcast(`📊 Processed ${entryCount} entries so far...`, "info")
      }

      const pathParts = relPath.split("/").filter((part) => part.length > 0)
      if (pathParts.length === 0) continue

      const deviceName = extractDeviceNameWithMacOSSupport(pathParts, structureInfo)
      if (!deviceName) continue

      if (!deviceMap.has(deviceName)) {
        deviceMap.set(deviceName, [])
        logWithBroadcast(`📱 New device detected: "${deviceName}" (device #${deviceMap.size})`, "info")
      }

      const fileInfo = entryByRelPath.get(relPath)
      if (fileInfo) {
        deviceMap.get(deviceName)!.push({ path: relPath, entry: new DiskEntryWrapper(fileInfo.absPath) })
      }
    }

    const devicesFound = deviceMap.size
    logWithBroadcast("✅ Device grouping complete:", "success")
    logWithBroadcast(`   - Total entries processed: ${entryCount}`, "info")
    logWithBroadcast(`   - Total devices found: ${devicesFound}`, "info")
    logWithBroadcast(`   - Structure type: ${structureInfo.structureType}`, "info")

    // Check for existing devices to avoid duplicates
    const deviceNames = Array.from(deviceMap.keys())
    const deviceHashes = deviceNames.map((name) => ({
      name,
      hash: crypto.createHash("sha256").update(name.toLowerCase()).digest("hex"),
    }))

    let existingDeviceHashes = new Set()
    if (deviceHashes.length > 0) {
      const existingDevicesQuery = `
        SELECT device_name_hash, device_name
        FROM devices
        WHERE device_name_hash IN (${deviceHashes.map(() => "?").join(",")})
      `
      const existingDevices = (await executeQuery(
        existingDevicesQuery,
        deviceHashes.map((d) => d.hash),
      )) as any[]
      existingDeviceHashes = new Set(existingDevices.map((d) => d.device_name_hash))
    }

    // Process each device
    logWithBroadcast(`🔄 Starting to process ${deviceMap.size} devices...`, "info")
    let devicesSkipped = 0
    let devicesProcessed = 0
    let totalFiles = 0
    let totalCredentials = 0
    let totalDomains = 0
    let totalUrls = 0
    let totalBinaryFiles = 0
    const processedDevices: string[] = []
    const skippedDevices: string[] = []
    let deviceIndex = 0

    for (const [deviceName, zipFiles] of deviceMap) {
      deviceIndex++
      logWithBroadcast(`\n🖥️ Processing device ${deviceIndex}/${deviceMap.size}: "${deviceName}"`, "info")
      logWithBroadcast(`[PROGRESS] ${deviceIndex}/${deviceMap.size}`, "info")

      const deviceHash = crypto.createHash("sha256").update(deviceName.toLowerCase()).digest("hex")

      if (existingDeviceHashes.has(deviceHash)) {
        logWithBroadcast(`⏭️ SKIPPING duplicate device: "${deviceName}"`, "warning")
        devicesSkipped++
        skippedDevices.push(deviceName)
        continue
      }

      logWithBroadcast(`✅ Device "${deviceName}" is NEW, proceeding with processing...`, "success")
      logWithBroadcast(`📁 Device has ${zipFiles.length} files`, "info")

      const deviceId = `device_${uploadBatch}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

      const deviceResult: DeviceProcessingResult = await processDevice(
        deviceName,
        zipFiles,
        deviceHash,
        deviceId,
        uploadBatch,
        extractionBaseDir,
        logWithBroadcast,
      )

      totalFiles += zipFiles.length
      devicesProcessed++
      processedDevices.push(deviceName)
      totalCredentials += deviceResult.deviceCredentials
      totalDomains += deviceResult.deviceDomains
      totalUrls += deviceResult.deviceUrls
      totalBinaryFiles += deviceResult.deviceBinaryFiles
    }

    logWithBroadcast("🎯 Processing summary:", "info")
    logWithBroadcast(`   - Structure type: ${structureInfo.structureType}`, "info")
    logWithBroadcast(`   - Devices found: ${devicesFound}`, "info")
    logWithBroadcast(`   - Devices processed: ${devicesProcessed}`, "info")
    logWithBroadcast(`   - Devices skipped: ${devicesSkipped}`, "info")
    logWithBroadcast(`   - Total credentials: ${totalCredentials}`, "info")
    logWithBroadcast(`   - Total domains: ${totalDomains}`, "info")
    logWithBroadcast(`   - Total URLs: ${totalUrls}`, "info")
    logWithBroadcast(`   - Total files: ${totalFiles}`, "info")
    logWithBroadcast(`   - Total binary files saved: ${totalBinaryFiles}`, "info")

    // Clear all analytics cache to ensure fresh data after upload
    await executeQuery(
      "DELETE FROM analytics_cache WHERE cache_key IN ('stats_main', 'browser_analysis', 'software_analysis', 'top_tlds')",
    )

    // Run domain monitor check for the entire batch (deferred from per-device)
    if (totalCredentials > 0) {
      try {
        await checkMonitorsForBatch(uploadBatch, logWithBroadcast)
      } catch (monitorError) {
        logWithBroadcast(`❌ Batch domain monitor check error: ${monitorError}`, "error")
      }
    }

    return {
      devicesFound,
      devicesProcessed,
      devicesSkipped,
      totalFiles,
      totalCredentials,
      totalDomains,
      totalUrls,
      totalBinaryFiles,
      uploadBatch,
      processedDevices,
      skippedDevices,
      structureInfo,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logWithBroadcast(`💥 Processing error: ${errorMessage}`, "error")
    throw error instanceof Error ? error : new Error(errorMessage)
  } finally {
    // Always clean up the raw extraction temp dir (distinct from the per-device
    // storage directories device-processor.ts writes into extractionBaseDir).
    try {
      if (existsSync(rawExtractDir)) {
        await rm(rawExtractDir, { recursive: true, force: true })
      }
    } catch (cleanupError) {
      logWithBroadcast(`⚠️ Failed to clean up temp extraction dir: ${cleanupError}`, "warning")
    }
  }
}
