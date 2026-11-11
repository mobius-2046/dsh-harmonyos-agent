// Run one harmony action without the GUI: node run-action.mjs <action> [device]
import { createHarmonyTools } from '../lib/tools.js'

const [action = 'devices', device] = process.argv.slice(2)
const [tool] = createHarmonyTools({})
const controller = new AbortController()
const result = await tool.execute(
  { action, projectDir: 'D:\\workspace_6\\xcommander_7885', ...(device ? { device } : {}) },
  { signal: controller.signal },
)
console.log('ok=', result.ok)
console.log(result.summary)
if (result.data?.devices) console.log('devices=', JSON.stringify(result.data.devices))
if (result.data?.sharedModulesMissing) console.log('missing=', JSON.stringify(result.data.sharedModulesMissing))
