import { lstatSync } from 'node:fs'
import { nodeFileContentsEqualSync } from './node-file-content-equality'

// Why: OpenCode 2 hot-reloads every plugin when a file in its plugins dir is rewritten, even with
// identical bytes, so installers must skip the write when Orca's plugin is already current.
export function isInstalledOpenCodePluginCurrent(pluginPath: string, source: string): boolean {
  try {
    // lstat: a mirrored symlink is the user's file, never Orca's, even when the bytes match.
    return lstatSync(pluginPath).isFile() && nodeFileContentsEqualSync(pluginPath, source)
  } catch {
    return false
  }
}
