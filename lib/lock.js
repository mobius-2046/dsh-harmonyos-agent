import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * A build lock owned by this tool, stored inside the project's `.hvigor` dir.
 *
 * It does not try to cooperate with DevEco Studio (which holds its own log
 * handle); it only stops two of *our* builds from running against the same
 * project at the same time — an agent that fires `build` and `run` in parallel
 * otherwise corrupts the shared-module artifacts and the failure surfaces much
 * later as "dependent module does not exist" on the device.
 */
export const LOCK_STALE_MS = 30 * 60 * 1000

export function lockPath(projectDir) {
  return join(projectDir, '.hvigor', 'dsh-harmony.build.lock')
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function readHolder(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return {
      pid: Number(parsed?.pid) || 0,
      startedAt: Number(parsed?.startedAt) || 0,
      projectDir: typeof parsed?.projectDir === 'string' ? parsed.projectDir : '',
    }
  } catch {
    return { pid: 0, startedAt: 0, projectDir: '' }
  }
}

function staleReason(holder, now, staleMs) {
  if (!holder.pid) return '锁文件损坏'
  if (!isProcessAlive(holder.pid)) return `进程 ${holder.pid} 已退出`
  if (holder.startedAt && now - holder.startedAt > staleMs) {
    const minutes = Math.round((now - holder.startedAt) / 60000)
    return `已持有 ${minutes} 分钟`
  }
  return ''
}

/**
 * @returns {{ok: boolean, path: string, holder?: object, reclaimed?: string}}
 */
export function acquireBuildLock(projectDir, { pid = process.pid, now = Date.now(), staleMs = LOCK_STALE_MS } = {}) {
  const path = lockPath(projectDir)
  if (existsSync(path)) {
    const holder = readHolder(path)
    const reason = staleReason(holder, now, staleMs)
    if (!reason) return { ok: false, path, holder }
    try {
      unlinkSync(path)
    } catch {
      return { ok: false, path, holder }
    }
    const body = { pid, startedAt: now, projectDir, reclaimed: reason }
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(body), 'utf8')
      return { ok: true, path, reclaimed: reason }
    } catch {
      return { ok: false, path, holder }
    }
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ pid, startedAt: now, projectDir }), 'utf8')
    return { ok: true, path }
  } catch {
    // A project we cannot write into fails later with a clearer hvigor error.
    return { ok: true, path: '' }
  }
}

export function releaseBuildLock(path, { pid = process.pid } = {}) {
  if (!path || !existsSync(path)) return false
  const holder = readHolder(path)
  if (holder.pid && holder.pid !== pid) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

export function describeHolder(holder, now = Date.now()) {
  if (!holder?.pid) return '未知进程'
  const seconds = holder.startedAt ? Math.round((now - holder.startedAt) / 1000) : 0
  const age = seconds > 90 ? `${Math.round(seconds / 60)} 分钟` : `${seconds} 秒`
  return `进程 ${holder.pid}，已持有 ${age}`
}
