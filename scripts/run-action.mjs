// Run one harmony action without the GUI, for real-device regression:
//   node run-action.mjs build
//   node run-action.mjs docs op=config dir=D:\docs-openharmony-6.1-release\zh-cn\application-dev
//   node run-action.mjs docs op=search query=@ohos.notificationManager
// Positional values after the action are read as key=value; a bare value is
// taken as `device`. JSON is accepted for non-string values (line=12, clean=true).
import { createHarmonyTools } from '../lib/tools.js'

const [action = 'devices', ...rest] = process.argv.slice(2)
const args = { action, projectDir: 'D:\\workspace_6\\xcommander_7885' }
for (const item of rest) {
  const eq = item.indexOf('=')
  if (eq < 0) {
    args.device = item
    continue
  }
  const key = item.slice(0, eq)
  const raw = item.slice(eq + 1)
  try {
    args[key] = JSON.parse(raw)
  } catch {
    args[key] = raw
  }
}

const [tool] = createHarmonyTools({})
const controller = new AbortController()
const result = await tool.execute(args, { signal: controller.signal })
console.log('ok=', result.ok)
console.log(result.summary)
if (result.data?.devices) console.log('devices=', JSON.stringify(result.data.devices))
if (result.data?.sharedModulesMissing) console.log('missing=', JSON.stringify(result.data.sharedModulesMissing))
