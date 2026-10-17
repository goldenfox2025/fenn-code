import { nodeScript } from './nodeScript'

/** Use the real Node runtime and JS entry when npm exposes Qoder through a symlink or shim. */
export function qoderCommand(config: Record<string, string>, args: string[]): {
  command: string; args: string[]; requires?: string[]
} {
  return nodeScript(config.QODER_CLI_PATH?.trim() || 'qodercli', '@qoder-ai/qodercli/bundle/qodercli.js', args, config.QODER_NODE_PATH)
}
