window.__ModuleLoader__.load({
  id: '@local/dsh-harmony',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The id shared by the sidebar entry and the main panel it opens. */
    const PANEL_ID = 'harmony-logs'
    /** Dictionary namespace owned by this plugin. */
    const NS = 'harmonyLogs'
    /** Authenticated Host routes registered by this bundle's index.js. */
    const DEVICES_API = '/api/harmony/logs/devices'
    const PROCESSES_API = '/api/harmony/logs/processes'
    const LOGS_API = '/api/harmony/logs'
    /** Levels in hilog order, weakest first. DevEco labels them Debug..Fatal. */
    const LEVELS = ['D', 'I', 'W', 'E', 'F']
    const LEVEL_LABELS = { D: 'Debug', I: 'Info', W: 'Warn', E: 'Error', F: 'Fatal' }
    /** Retained rows; older lines are dropped so a long session stays bounded. */
    const MAX_LINES = 4000
    /** Rows actually mounted; the retained buffer stays larger than the DOM. */
    const MAX_RENDER = 800
    /** How often buffered frames reach React state. */
    const FLUSH_MS = 200
    /** Delay before reconnecting a dropped capture. */
    const RETRY_MS = 1500
    /** Log font sizes offered in the panel; 32 is the default DevEco-like reading size. */
    const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32]
    const FONT_DEFAULT = 32
    const FONT_KEY = 'harmony.logs.font'
    /** Snapshots live per browser so a baseline survives panel remounts. */
    const SNAPSHOT_KEY = 'harmony.logs.snapshots'
    /** Kept snapshots; the oldest is dropped so storage stays bounded. */
    const SNAPSHOTS_MAX = 6
    /** Rows kept per snapshot; mirrors the live buffer bound. */
    const SNAPSHOT_LINES_MAX = 4000

    /**
     * The stored log font size, or the default. Storage is best-effort: a
     * blocked localStorage must not take the panel down.
     * @returns {number}
     */
    function readFontSize() {
      try {
        const stored = Number(window.localStorage.getItem(FONT_KEY))
        if (FONT_SIZES.includes(stored)) return stored
      } catch {}
      return FONT_DEFAULT
    }

    /**
     * Remember the log font size across panel remounts.
     * @param {number} value chosen size.
     */
    function storeFontSize(value) {
      try {
        window.localStorage.setItem(FONT_KEY, String(value))
      } catch {}
    }

    /**
     * Read stored snapshots, dropping anything that is not the expected shape.
     * A blocked or corrupted store degrades to "no snapshots" rather than
     * throwing inside render.
     * @returns {{ id: string, at: string, device: string, lines: string[] }[]}
     */
    function readSnapshots() {
      try {
        const raw = window.localStorage.getItem(SNAPSHOT_KEY)
        const parsed = raw === null ? [] : JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed.filter((entry) => entry !== null
          && typeof entry === 'object'
          && typeof entry.id === 'string'
          && typeof entry.at === 'string'
          && typeof entry.device === 'string'
          && Array.isArray(entry.lines)
          && entry.lines.every((line) => typeof line === 'string'))
      } catch {
        return []
      }
    }

    /**
     * Persist snapshots best-effort. Quota errors must not break the panel.
     * @param {object[]} snapshots list to store.
     */
    function storeSnapshots(snapshots) {
      try {
        window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshots))
      } catch {}
    }

    /**
     * Compare two log snapshots as multisets of lines.
     *
     * A log is append-heavy and repeats similar lines, so a positional diff
     * reports noise; counting line occurrences answers the question that
     * matters after a fix ("did this message stop appearing?").
     * @param {{ lines: string[] }} before baseline snapshot.
     * @param {{ lines: string[] }} after snapshot to compare.
     * @returns {{ added: string[], removed: string[], same: number }}
     */
    function diffSnapshots(before, after) {
      const count = (lines) => {
        const map = new Map()
        for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1)
        return map
      }
      const left = count(before.lines)
      const right = count(after.lines)
      const added = []
      const removed = []
      let same = 0
      for (const [line, occurrences] of right) {
        const before_count = left.get(line) ?? 0
        same += Math.min(occurrences, before_count)
        for (let index = before_count; index < occurrences; index += 1) added.push(line)
      }
      for (const [line, occurrences] of left) {
        const after_count = right.get(line) ?? 0
        for (let index = after_count; index < occurrences; index += 1) removed.push(line)
      }
      return { added, removed, same }
    }

    const zh = {
      panel: 'hilog',
      title: 'hilog 日志',
      device: '设备',
      devicesNone: '无设备',
      refreshDevices: '刷新设备',
      process: '进程',
      allProcesses: '全部进程',
      refreshProcesses: '刷新进程列表',
      level: '级别',
      allLevels: '全部级别',
      filter: '过滤器',
      filterTag: '标签',
      filterTagHint: 'tag 或 domain',
      filterInclude: '包含',
      filterIncludeHint: '日志行必须包含',
      filterExclude: '排除',
      filterExcludeHint: '日志行不能包含',
      filterApply: '应用',
      filterClear: '清除',
      search: '搜索',
      searchPlaceholder: '在日志中搜索',
      matchCase: '匹配大小写',
      regex: '正则表达式',
      prevMatch: '上一处',
      nextMatch: '下一处',
      noMatch: '无匹配',
      invalidRegex: '正则无效',
      pause: '暂停',
      resume: '继续',
      scrollEnd: '滚动到底部',
      softWrap: '自动换行',
      compact: '紧凑视图',
      standard: '标准视图',
      save: '保存',
      snapshot: '快照',
      compare: '对比',
      snapshotSaved: '已保存快照（{n} 行）',
      snapshotsNone: '还没有快照。点「快照」把当前日志存一份，等复现后再对比。',
      compareTitle: '对比两份快照',
      compareBase: '基准',
      compareTarget: '当前',
      compareRun: '开始对比',
      compareClose: '收起',
      diffSummary: '新增 {added} 行，消失 {removed} 行，相同 {same} 行',
      diffIdentical: '两份快照完全一致。',
      diffTruncated: '（只显示前 {n} 行差异）',
      clear: '全部清除',
      fontSize: '字号',
      'col.time': '时间',
      'col.pid': '进程',
      'col.tid': '线程',
      'col.level': '级别',
      'col.tag': '标签',
      'col.message': '消息',
      'status.idle': '未开始',
      'status.connecting': '连接中…',
      'status.live': '实时跟随',
      'status.paused': '已暂停',
      'status.reconnecting': '连接中断，正在重连…',
      'status.error': '读取失败',
      'status.unavailable': '日志服务未加载',
      'empty.none': '暂无日志',
      'empty.noneHint': '设备产生新日志时会出现在这里。',
      'empty.noDevice': '未检测到设备',
      'empty.noDeviceHint': '连接真机或启动模拟器后点「刷新设备」。',
      'empty.unavailable': '日志服务未加载',
      'empty.unavailableHint': '插件已更新，但宿主仍在运行旧代码：重启 DeepSeek Harness 后即可读取日志。',
      'empty.filtered': '没有符合筛选条件的日志',
      'empty.filteredHint': '放宽级别、进程或过滤器条件。',
      'error.devices': '读取设备列表失败',
      'error.processes': '读取进程列表失败',
      'error.save': '保存失败，请手动选择日志文本复制。',
      'foot.total': '共 {n} 条',
      'foot.shown': '显示 {n} 条',
      'foot.retained': '{n} 条已保留',
    }

    const en = {
      panel: 'hilog',
      title: 'hilog logs',
      device: 'Device',
      devicesNone: 'No device',
      refreshDevices: 'Refresh devices',
      process: 'Process',
      allProcesses: 'All processes',
      refreshProcesses: 'Refresh process list',
      level: 'Level',
      allLevels: 'All levels',
      filter: 'Filter',
      filterTag: 'Tag',
      filterTagHint: 'tag or domain',
      filterInclude: 'Include',
      filterIncludeHint: 'Line must contain',
      filterExclude: 'Exclude',
      filterExcludeHint: 'Line must not contain',
      filterApply: 'Apply',
      filterClear: 'Clear',
      search: 'Search',
      searchPlaceholder: 'Search in logs',
      matchCase: 'Match case',
      regex: 'Regex',
      prevMatch: 'Previous match',
      nextMatch: 'Next match',
      noMatch: 'No match',
      invalidRegex: 'Invalid regex',
      pause: 'Pause',
      resume: 'Resume',
      scrollEnd: 'Scroll to end',
      softWrap: 'Soft-wrap',
      compact: 'Compact view',
      standard: 'Standard view',
      save: 'Save',
      snapshot: 'Snapshot',
      compare: 'Compare',
      snapshotSaved: 'Snapshot saved ({n} lines)',
      snapshotsNone: 'No snapshots yet. Take one before reproducing, another after, then compare.',
      compareTitle: 'Compare two snapshots',
      compareBase: 'Baseline',
      compareTarget: 'Current',
      compareRun: 'Compare',
      compareClose: 'Hide',
      diffSummary: '{added} new lines, {removed} gone, {same} unchanged',
      diffIdentical: 'Both snapshots are identical.',
      diffTruncated: '(showing the first {n} differing lines)',
      clear: 'Clear all',
      fontSize: 'Font size',
      'col.time': 'Time',
      'col.pid': 'PID',
      'col.tid': 'TID',
      'col.level': 'Lvl',
      'col.tag': 'Tag',
      'col.message': 'Message',
      'status.idle': 'Idle',
      'status.connecting': 'Connecting…',
      'status.live': 'Following live',
      'status.paused': 'Paused',
      'status.reconnecting': 'Disconnected, reconnecting…',
      'status.error': 'Read failed',
      'status.unavailable': 'Log service not loaded',
      'empty.none': 'No logs yet',
      'empty.noneHint': 'New device logs appear here.',
      'empty.noDevice': 'No device detected',
      'empty.noDeviceHint': 'Connect a device or start an emulator, then refresh.',
      'empty.unavailable': 'Log service not loaded',
      'empty.unavailableHint': 'The plugin was updated but the host still runs the old code. Restart DeepSeek Harness to read logs.',
      'empty.filtered': 'No logs match the filters',
      'empty.filteredHint': 'Enable more levels or relax the process and filter settings.',
      'error.devices': 'Could not read the device list',
      'error.processes': 'Could not read the process list',
      'error.save': 'Save failed; select and copy the log text manually.',
      'foot.total': '{n} total',
      'foot.shown': '{n} shown',
      'foot.retained': '{n} retained',
    }

    const DICTIONARIES = { zh, en }

    /**
     * One row model for a frame. Continuations carry no prefix and are folded
     * into the previous row at ingest instead of becoming a row.
     * @param {object} frame parsed frame.
     * @param {number} id monotonic row id.
     * @returns {object}
     */
    function toRow(frame, id) {
      return {
        id,
        time: frame.time ?? '',
        level: frame.level ?? '',
        pid: frame.pid ?? 0,
        tid: frame.tid ?? 0,
        domain: frame.domain ?? '',
        tag: frame.tag ?? '',
        message: frame.message ?? '',
      }
    }

    /**
     * The plain-text form of a row, used by Save.
     * @param {object} row row model.
     * @returns {string}
     */
    function rowText(row) {
      return `${row.time} ${String(row.pid).padStart(5)} ${String(row.tid).padStart(5)} ${row.level || '?'} ${row.domain}/${row.tag}: ${row.message}`
    }

    /**
     * Message text over the injected `t` seat, falling back to the Chinese
     * dictionary so a missing seat still shows readable copy.
     * @param {((key: string) => string) | undefined} injected slot translator.
     * @returns {(key: string, vars?: Record<string, string | number>) => string}
     */
    function translator(injected) {
      return (key, vars) => {
        const fromSlot = typeof injected === 'function' ? injected(key) : undefined
        const text = typeof fromSlot === 'string' && fromSlot !== key ? fromSlot : (zh[key] ?? key)
        if (vars === undefined) return text
        return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
      }
    }

    /** Panel-owned stylesheet. Every color is a host theme token. */
    const CSS = [
      '.hl-page{box-sizing:border-box;height:100%;color:var(--dsw-alias-label-primary);flex-direction:column;gap:10px;display:flex;overflow:hidden;padding:0 clamp(16px,2.4vw,32px) 16px;--hl-cols:132px 52px 52px 16px minmax(140px,260px) minmax(0,1fr)}',
      ".hl-page[data-compact='true']{--hl-cols:132px 16px minmax(120px,220px) minmax(0,1fr)}",
      '.hl-head{flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;padding-top:20px;display:flex}',
      "[data-platform='darwin'] .hl-head{padding-top:calc(20px + var(--dsh-frame-top-clearance,0px))}",
      '.hl-heading{min-width:0;max-width:100%;align-items:baseline;gap:10px;display:flex;flex-wrap:wrap}',
      '.hl-title{margin:0;font-size:18px;font-weight:500;line-height:26px}',
      '.hl-intro{color:var(--dsw-alias-label-secondary);align-items:center;gap:6px;margin:0;font-size:12px;line-height:20px;display:flex;flex-wrap:wrap}',
      '.hl-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}',
      '.hl-dot-live{background:var(--dsw-alias-state-success-primary)}',
      '.hl-dot-connecting,.hl-dot-reconnecting{background:var(--dsw-alias-state-warn-primary)}',
      '.hl-dot-error,.hl-dot-unavailable{background:var(--dsw-alias-state-error-primary)}',
      '.hl-control{box-sizing:border-box;height:28px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font:inherit;font-size:12px;padding:0 8px}',
      '.hl-control:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.hl-control:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.hl-control:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      ".hl-control[aria-pressed='true']{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}",
      '.hl-icon-btn{width:28px;padding:0;justify-content:center;align-items:center;display:inline-flex}',
      '.hl-filterbar,.hl-actionbar{align-items:center;gap:6px;display:flex;flex-wrap:wrap}',
      '.hl-filterbar{row-gap:8px}',
      '.hl-select{max-width:220px;min-width:96px}',
      '.hl-process-select{max-width:230px}',
      '.hl-search{flex:1;min-width:160px;max-width:420px}',
      '.hl-search-wrap{flex:1;min-width:220px;max-width:560px;align-items:center;gap:4px;display:flex}',
      '.hl-search-wrap .hl-search{flex:1}',
      '.hl-count{color:var(--dsw-alias-label-tertiary);min-width:52px;font-size:12px;text-align:right;white-space:nowrap}',
      '.hl-count-invalid{color:var(--dsw-alias-state-error-primary)}',
      '.hl-pop{position:relative;display:inline-flex}',
      '.hl-menu{background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;flex-direction:column;gap:2px;min-width:200px;padding:8px;display:flex;position:absolute;top:calc(100% + 4px);left:0;z-index:20}',
      '.hl-menu-right{left:auto;right:0}',
      '.hl-menu-title{color:var(--dsw-alias-label-tertiary);margin:2px 4px 4px;font-size:11px;line-height:16px}',
      '.hl-check{color:var(--dsw-alias-label-primary);align-items:center;gap:8px;border-radius:4px;padding:3px 4px;font-size:12px;line-height:18px;display:flex;cursor:pointer}',
      '.hl-check:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.hl-check input{margin:0}',
      '.hl-check .hl-lv{width:10px}',
      '.hl-lv{font-weight:600;text-align:center}',
      "[data-level='D'].hl-lv{color:var(--dsw-alias-state-business-primary)}",
      "[data-level='I'].hl-lv{color:var(--dsw-alias-state-success-primary)}",
      "[data-level='W'].hl-lv{color:var(--dsw-alias-state-warn-primary)}",
      "[data-level='E'].hl-lv,[data-level='F'].hl-lv{color:var(--dsw-alias-state-error-primary)}",
      '.hl-field{flex-direction:column;gap:4px;margin:2px 4px 6px;display:flex}',
      '.hl-field label{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.hl-field input{box-sizing:border-box;height:26px;width:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;font:inherit;font-size:12px;padding:0 6px}',
      '.hl-menu-actions{border-top:1px solid var(--dsw-alias-border-l1);justify-content:flex-end;gap:6px;margin-top:4px;padding-top:8px;display:flex}',
      '.hl-font{color:var(--dsw-alias-label-secondary);align-items:center;gap:6px;font-size:12px;display:inline-flex}',
      '.hl-font select{height:26px}',
      '.hl-headrow{box-sizing:border-box;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1);grid-template-columns:var(--hl-cols);gap:8px;padding:0 10px 4px;font-size:clamp(11px,calc(var(--hl-font,32px) * .42),16px);line-height:1.6;display:grid}',
      '.hl-surface{min-height:0;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;flex:1;overflow:auto;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:var(--hl-font,32px);line-height:calc(var(--hl-font,32px) * 1.45)}',
      '.hl-row{display:grid;grid-template-columns:var(--hl-cols);gap:8px;padding:0 10px;white-space:nowrap;user-select:text;align-items:start}',
      '.hl-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      ".hl-page[data-wrap='true'] .hl-row{white-space:pre-wrap}",
      ".hl-page[data-wrap='true'] .hl-cell{white-space:pre-wrap;overflow-wrap:anywhere;text-overflow:clip}",
      '.hl-cell{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.hl-time,.hl-pid,.hl-tid{color:var(--dsw-alias-label-tertiary)}',
      ".hl-row[data-level='D']{color:var(--dsw-alias-label-secondary)}",
      ".hl-row[data-level='W']{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent)}",
      ".hl-row[data-level='W'] .hl-lv,.hl-row[data-level='W'] .hl-cell-msg{color:var(--dsw-alias-state-warn-primary)}",
      ".hl-row[data-level='E'],.hl-row[data-level='F']{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}",
      ".hl-row[data-level='E'] .hl-lv,.hl-row[data-level='F'] .hl-lv,.hl-row[data-level='E'] .hl-cell-msg,.hl-row[data-level='F'] .hl-cell-msg{color:var(--dsw-alias-state-error-primary)}",
      '.hl-cell-tag{color:var(--dsw-alias-label-secondary)}',
      '.hl-mark{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 32%,transparent);border-radius:2px;color:inherit}',
      '.hl-mark-active{background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-bg-base)}',
      '.hl-empty{height:100%;color:var(--dsw-alias-label-tertiary);flex-direction:column;justify-content:center;align-items:center;gap:6px;padding:24px;display:flex;text-align:center;font-family:var(--dsw-font-family,system-ui)}',
      '.hl-empty p{margin:0;font-size:13px;line-height:20px}',
      '.hl-empty .hl-empty-title{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}',
      '.hl-foot{color:var(--dsw-alias-label-tertiary);justify-content:space-between;align-items:center;gap:12px;min-height:20px;font-size:12px;line-height:20px;display:flex}',
      '.hl-foot-error{color:var(--dsw-alias-state-error-primary)}',
      '.hl-compare{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;flex-direction:column;gap:8px;max-height:52%;padding:12px;display:flex}',
      '.hl-compare-head{justify-content:space-between;align-items:center;gap:10px;display:flex;flex-wrap:wrap}',
      '.hl-compare-title{margin:0;font-size:13px;font-weight:500;line-height:20px}',
      '.hl-compare-row{align-items:center;gap:6px;display:flex;flex-wrap:wrap}',
      '.hl-compare-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}',
      '.hl-diff{min-height:64px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;flex:1;overflow:auto;padding:8px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:12px;line-height:1.55;white-space:pre-wrap}',
      '.hl-diff-add{color:var(--dsw-alias-state-success-primary)}',
      '.hl-diff-del{color:var(--dsw-alias-state-error-primary)}',
    ].join('')

    /**
     * A trigger plus its dropdown panel, closed by an outside press or Escape.
     * @param {object} props open state, toggle/close callbacks, trigger label, children.
     * @returns {object}
     */
    function Dropdown(props) {
      const ref = React.useRef(null)
      const close = props.onClose

      React.useEffect(() => {
        if (!props.open) return undefined
        const onPointerDown = (event) => {
          if (ref.current !== null && !ref.current.contains(event.target)) close()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') close()
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [props.open, close])

      return h('div', { className: 'hl-pop', ref },
        h('button', {
          type: 'button',
          className: `hl-control ${props.className ?? ''}`,
          'aria-expanded': props.open,
          'aria-haspopup': 'true',
          onClick: props.onToggle,
        }, props.label),
        props.open
          ? h('div', { className: `hl-menu ${props.align === 'right' ? 'hl-menu-right' : ''}`, role: 'group' }, props.children)
          : null,
      )
    }

    /**
     * The log panel, laid out after DevEco Studio's HiLog window: a device /
     * process / level / filter bar with in-view search, an action bar, a column
     * header, and the console with level coloring and match highlighting.
     * @param {object} props slot props; `t` is bound to this plugin's namespace.
     * @returns {object} page element.
     */
    function LogsPage(props) {
      const t = React.useMemo(() => translator(props.t), [props.t])
      const tRef = React.useRef(t)
      tRef.current = t

      const [devices, setDevices] = React.useState([])
      const [device, setDevice] = React.useState('')
      const [devicesState, setDevicesState] = React.useState('loading')
      const [processes, setProcesses] = React.useState([])
      const [processesState, setProcessesState] = React.useState('idle')
      const [processPid, setProcessPid] = React.useState(0)
      const [levels, setLevels] = React.useState({ D: false, I: true, W: true, E: true, F: true })
      const [levelOpen, setLevelOpen] = React.useState(false)
      const [filterOpen, setFilterOpen] = React.useState(false)
      const [filters, setFilters] = React.useState({ tag: '', include: '', exclude: '' })
      const [query, setQuery] = React.useState('')
      const [matchCase, setMatchCase] = React.useState(false)
      const [regexMode, setRegexMode] = React.useState(false)
      const [matchIndex, setMatchIndex] = React.useState(0)
      const [searchEpoch, setSearchEpoch] = React.useState(0)
      const [running, setRunning] = React.useState(true)
      const [autoScroll, setAutoScroll] = React.useState(true)
      // Large log text leaves too little room for one-line messages, so wrapping
      // starts on and the action bar can switch it off.
      const [wrap, setWrap] = React.useState(true)
      const [compact, setCompact] = React.useState(false)
      const [fontSize, setFontSize] = React.useState(readFontSize)
      const [status, setStatus] = React.useState('idle')
      const [error, setError] = React.useState('')
      const [lines, setLines] = React.useState([])
      const [total, setTotal] = React.useState(0)
      const [attempt, setAttempt] = React.useState(0)
      const [snapshots, setSnapshots] = React.useState(readSnapshots)
      const [compareOpen, setCompareOpen] = React.useState(false)
      const [compareBase, setCompareBase] = React.useState('')
      const [compareTarget, setCompareTarget] = React.useState('')
      const [compareResult, setCompareResult] = React.useState(null)

      const surfaceRef = React.useRef(null)
      const idRef = React.useRef(0)
      const searchRef = React.useRef({ total: 0, rows: [] })
      const activeMatchRef = React.useRef(0)

      const loadDevices = React.useCallback(async () => {
        setDevicesState('loading')
        try {
          const response = await fetch(DEVICES_API, { headers: { accept: 'application/json' } })
          if (response.status === 404) {
            setDevicesState('unavailable')
            setStatus('unavailable')
            return
          }
          if (!response.ok) {
            setDevicesState('error')
            setError(tRef.current('error.devices'))
            return
          }
          const data = await response.json()
          const found = Array.isArray(data.devices) ? data.devices.filter((id) => typeof id === 'string') : []
          setDevices(found)
          setDevicesState('ready')
          setDevice((current) => (found.includes(current) ? current : (found[0] ?? '')))
        } catch (failure) {
          setDevicesState('error')
          setError(failure && failure.message ? failure.message : tRef.current('error.devices'))
        }
      }, [])

      const loadProcesses = React.useCallback(async (target) => {
        if (typeof target !== 'string' || target === '') return
        setProcessesState('loading')
        try {
          const response = await fetch(`${PROCESSES_API}?device=${encodeURIComponent(target)}`, { headers: { accept: 'application/json' } })
          if (!response.ok) {
            setProcessesState('error')
            setProcesses([])
            if (response.status !== 404) setError(tRef.current('error.processes'))
            return
          }
          const data = await response.json()
          const found = Array.isArray(data.processes)
            ? data.processes.filter((entry) => entry && typeof entry.pid === 'number' && typeof entry.name === 'string')
            : []
          setProcesses(found)
          setProcessesState('ready')
        } catch {
          setProcessesState('error')
          setProcesses([])
        }
      }, [])

      React.useEffect(() => {
        loadDevices()
      }, [loadDevices])

      React.useEffect(() => {
        setProcesses([])
        setProcessPid(0)
        if (device !== '') loadProcesses(device)
      }, [device, loadProcesses])

      // One capture stream per device. Pausing aborts it and keeps the rows;
      // resuming, switching device, or a retry starts a fresh one. A failed or
      // ended capture reconnects after RETRY_MS rather than leaving the panel dead.
      React.useEffect(() => {
        if (device === '' || !running) return undefined
        let disposed = false
        const controller = new AbortController()
        const pending = []
        let retryTimer = null

        const flush = () => {
          if (pending.length === 0) return
          const batch = pending.splice(0, pending.length)
          setLines((previous) => {
            const next = previous.slice()
            for (const frame of batch) {
              if (frame.continuation === true && next.length > 0) {
                const last = next[next.length - 1]
                next[next.length - 1] = { ...last, message: `${last.message}\n${frame.message}` }
                continue
              }
              idRef.current += 1
              next.push(toRow(frame, idRef.current))
            }
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
          })
          setTotal((count) => count + batch.filter((frame) => frame.continuation !== true).length)
        }

        const flushTimer = setInterval(flush, FLUSH_MS)

        const handleFrame = (frame) => {
          if (frame.type === 'line') pending.push(frame)
          else if (frame.type === 'error') setError(String(frame.message ?? 'error'))
        }

        const scheduleRetry = () => {
          if (disposed) return
          retryTimer = setTimeout(() => {
            if (!disposed) setAttempt((value) => value + 1)
          }, RETRY_MS)
        }

        const read = async () => {
          setStatus(attempt === 0 ? 'connecting' : 'reconnecting')
          const url = `${LOGS_API}?device=${encodeURIComponent(device)}&prefill=200`
          try {
            const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/x-ndjson' } })
            if (response.status === 404) {
              setStatus('unavailable')
              return
            }
            if (!response.ok) {
              setStatus('error')
              setError(`HTTP ${response.status}`)
              if (response.status !== 429) scheduleRetry()
              return
            }
            setStatus('live')
            setError('')
            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let rest = ''
            for (;;) {
              const { value, done } = await reader.read()
              if (done) break
              rest += decoder.decode(value, { stream: true })
              let index = rest.indexOf('\n')
              while (index !== -1) {
                const line = rest.slice(0, index)
                rest = rest.slice(index + 1)
                index = rest.indexOf('\n')
                if (line.trim() === '') continue
                try {
                  handleFrame(JSON.parse(line))
                } catch {}
              }
            }
            if (!disposed) {
              setStatus('reconnecting')
              scheduleRetry()
            }
          } catch (failure) {
            if (disposed || controller.signal.aborted) return
            setStatus('error')
            setError(failure && failure.message ? failure.message : String(failure))
            scheduleRetry()
          }
        }

        read()

        return () => {
          disposed = true
          controller.abort()
          clearInterval(flushTimer)
          if (retryTimer !== null) clearTimeout(retryTimer)
          flush()
        }
      }, [device, running, attempt])

      // Filters run over the retained buffer, exactly as DevEco's console filters
      // do, so changing a level, process, or custom filter never restarts capture.
      const visible = React.useMemo(() => {
        const tagNeedle = filters.tag.trim().toLowerCase()
        const includeNeedle = filters.include.trim().toLowerCase()
        const excludeNeedle = filters.exclude.trim().toLowerCase()
        const kept = lines.filter((row) => {
          if (row.level !== '' && levels[row.level] !== true) return false
          if (processPid !== 0 && row.pid !== processPid) return false
          if (tagNeedle !== '' && !`${row.domain}/${row.tag}`.toLowerCase().includes(tagNeedle)) return false
          if (includeNeedle !== '' || excludeNeedle !== '') {
            const haystack = `${row.tag} ${row.domain} ${row.message}`.toLowerCase()
            if (includeNeedle !== '' && !haystack.includes(includeNeedle)) return false
            if (excludeNeedle !== '' && haystack.includes(excludeNeedle)) return false
          }
          return true
        })
        return kept.length > MAX_RENDER ? kept.slice(kept.length - MAX_RENDER) : kept
      }, [lines, levels, processPid, filters])

      const searchRegex = React.useMemo(() => {
        if (query === '') return null
        const source = regexMode ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        try {
          return new RegExp(source, matchCase ? 'g' : 'gi')
        } catch {
          return null
        }
      }, [query, regexMode, matchCase])

      const search = React.useMemo(() => {
        if (searchRegex === null) return { total: 0, rows: [] }
        let total = 0
        const rows = []
        for (const row of visible) {
          searchRegex.lastIndex = 0
          let count = 0
          let match
          const text = `${row.tag} ${row.message}`
          while ((match = searchRegex.exec(text)) !== null) {
            count += 1
            if (match[0] === '') searchRegex.lastIndex += 1
            if (count >= 200) break
          }
          if (count > 0) {
            rows.push({ id: row.id, start: total, count })
            total += count
          }
          if (total >= 4000) break
        }
        return { total, rows }
      }, [visible, searchRegex])

      const startById = React.useMemo(() => {
        const map = new Map()
        for (const entry of search.rows) map.set(entry.id, entry.start)
        return map
      }, [search])

      searchRef.current = search
      const activeMatch = search.total === 0 ? 0 : Math.min(matchIndex, search.total - 1)
      activeMatchRef.current = activeMatch

      React.useEffect(() => {
        setMatchIndex(0)
        setSearchEpoch((value) => value + 1)
      }, [query, matchCase, regexMode])

      React.useEffect(() => {
        const current = searchRef.current
        if (current.total === 0) return
        const target = current.rows.find((row) => activeMatchRef.current >= row.start && activeMatchRef.current < row.start + row.count)
        if (target === undefined) return
        const node = surfaceRef.current === null ? null : surfaceRef.current.querySelector(`[data-row="${target.id}"]`)
        if (node !== null && typeof node.scrollIntoView === 'function') {
          setAutoScroll(false)
          node.scrollIntoView({ block: 'nearest' })
        }
      }, [activeMatch, searchEpoch])

      React.useEffect(() => {
        const node = surfaceRef.current
        if (node === null || !autoScroll) return
        node.scrollTop = node.scrollHeight
      }, [visible, autoScroll])

      const onScroll = () => {
        const node = surfaceRef.current
        if (node === null) return
        const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24
        if (atBottom !== autoScroll) setAutoScroll(atBottom)
      }

      const scrollToBottom = () => {
        setAutoScroll(true)
        const node = surfaceRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }

      const stepMatch = (delta) => {
        const count = searchRef.current.total
        if (count === 0) return
        setMatchIndex((current) => {
          const base = Math.min(current, count - 1)
          return (base + delta + count) % count
        })
      }

      const save = () => {
        try {
          const blob = new Blob([visible.map(rowText).join('\n')], { type: 'text/plain;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          anchor.href = url
          anchor.download = `hilog-${stamp}.log`
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        } catch {
          setError(t('error.save'))
        }
      }

      const toggleRun = () => {
        if (running) setStatus('paused')
        else {
          setAttempt(0)
          setStatus('connecting')
        }
        setRunning(!running)
      }

      /**
       * Freeze the filtered view into a named snapshot.
       *
       * The filter is applied first on purpose: "compare what I care about"
       * beats re-deriving a filter in the diff view.
       */
      const takeSnapshot = () => {
        const rows = visible.map(rowText)
        if (rows.length === 0) return
        const now = new Date()
        const entry = {
          id: `${now.getTime()}`,
          at: now.toLocaleTimeString(undefined, { hour12: false }),
          device: device === '' ? t('devicesNone') : device,
          lines: rows.slice(-SNAPSHOT_LINES_MAX),
        }
        setSnapshots((current) => {
          const next = [entry, ...current].slice(0, SNAPSHOTS_MAX)
          storeSnapshots(next)
          return next
        })
        setCompareResult(null)
      }

      const openCompare = () => {
        setCompareOpen((open) => {
          if (open) return false
          const list = snapshots
          if (list.length === 0) return true
          setCompareTarget(list[0].id)
          setCompareBase((list[1] ?? list[0]).id)
          return true
        })
      }

      const runCompare = () => {
        const base = snapshots.find((entry) => entry.id === compareBase)
        const target = snapshots.find((entry) => entry.id === compareTarget)
        setCompareResult(base !== undefined && target !== undefined ? diffSnapshots(base, target) : null)
      }

      const toggleLevel = (level) => setLevels((current) => ({ ...current, [level]: current[level] !== true }))
      const allLevelsOn = LEVELS.every((level) => levels[level] === true)
      const toggleAllLevels = () => {
        const next = {}
        for (const level of LEVELS) next[level] = !allLevelsOn
        setLevels(next)
      }

      const activeFilterCount = ['tag', 'include', 'exclude'].filter((key) => filters[key].trim() !== '').length
      const selectedLevels = LEVELS.filter((level) => levels[level])
      const levelLabel = allLevelsOn ? t('allLevels') : (selectedLevels.length === 0 ? '—' : selectedLevels.join(' '))

      const statusKey = {
        idle: 'status.idle',
        connecting: 'status.connecting',
        live: 'status.live',
        paused: 'status.paused',
        reconnecting: 'status.reconnecting',
        error: 'status.error',
        unavailable: 'status.unavailable',
      }[status] ?? 'status.idle'

      const emptyKey = devicesState === 'unavailable'
        ? 'empty.unavailable'
        : (devices.length === 0 ? 'empty.noDevice' : (lines.length > 0 ? 'empty.filtered' : 'empty.none'))
      const emptyHintKey = `${emptyKey}Hint`
      const columns = compact
        ? ['col.time', 'col.level', 'col.tag', 'col.message']
        : ['col.time', 'col.pid', 'col.tid', 'col.level', 'col.tag', 'col.message']

      // Monospace advance is ~0.6em, so the fixed columns scale with the chosen
      // log font while the message keeps the remaining width.
      const advance = fontSize * 0.6
      const span = (count) => `${Math.round(advance * count)}px`
      const gridColumns = compact
        ? `${span(19)} ${span(2)} minmax(${span(12)},${span(24)}) minmax(0,1fr)`
        : `${span(19)} ${span(5)} ${span(5)} ${span(2)} minmax(${span(12)},${span(24)}) minmax(0,1fr)`

      const searchCount = searchRegex === null && query !== ''
        ? h('span', { className: 'hl-count hl-count-invalid' }, t('invalidRegex'))
        : (query === ''
          ? null
          : h('span', { className: 'hl-count' }, search.total === 0 ? t('noMatch') : `${activeMatch + 1}/${search.total}`))

      return h('div', {
        className: 'hl-page',
        'data-compact': compact ? 'true' : 'false',
        'data-wrap': wrap ? 'true' : 'false',
        style: { '--hl-font': `${fontSize}px`, '--hl-cols': gridColumns },
      },
      h('style', null, CSS),
      h('header', { className: 'hl-head' },
        h('div', { className: 'hl-heading' },
          h('h1', { className: 'hl-title' }, t('title')),
          h('p', { className: 'hl-intro' },
            h('span', { className: `hl-dot hl-dot-${status}`, 'aria-hidden': 'true' }),
            h('span', null, t(statusKey)),
            device === '' ? null : h('span', null, `· ${device}`),
            h('span', null, `· ${t('foot.total', { n: total })}`),
            h('span', null, `· ${t('foot.shown', { n: visible.length })}`),
          ),
        ),
      ),
      h('div', { className: 'hl-filterbar' },
        h('select', {
          className: 'hl-control hl-select',
          value: device,
          'aria-label': t('device'),
          onChange: (event) => {
            setAttempt(0)
            setLines([])
            setTotal(0)
            setError('')
            setStatus(running ? 'connecting' : 'paused')
            setDevice(event.target.value)
          },
        },
        devices.length === 0
          ? h('option', { value: '' }, t('devicesNone'))
          : devices.map((id) => h('option', { key: id, value: id }, id)),
        ),
        h('button', {
          className: 'hl-control hl-icon-btn',
          type: 'button',
          onClick: loadDevices,
          title: t('refreshDevices'),
          'aria-label': t('refreshDevices'),
        }, '⟳'),
        h('select', {
          className: 'hl-control hl-select hl-process-select',
          value: String(processPid),
          'aria-label': t('process'),
          onChange: (event) => setProcessPid(Number.parseInt(event.target.value, 10) || 0),
        },
        h('option', { value: '0' }, t('allProcesses')),
        processes.map((entry) => h('option', { key: `${entry.pid}:${entry.name}`, value: String(entry.pid) }, `${entry.name} (${entry.pid})`)),
        ),
        h('button', {
          className: 'hl-control hl-icon-btn',
          type: 'button',
          onClick: () => loadProcesses(device),
          disabled: device === '' || processesState === 'loading',
          title: t('refreshProcesses'),
          'aria-label': t('refreshProcesses'),
        }, '⟳'),

        h(Dropdown, {
          className: 'hl-select',
          label: `${t('level')} · ${levelLabel}`,
          open: levelOpen,
          onToggle: () => setLevelOpen((value) => !value),
          onClose: () => setLevelOpen(false),
        },
        h('div', { className: 'hl-menu-title' }, t('level')),
        h('label', { className: 'hl-check' },
          h('input', { type: 'checkbox', checked: allLevelsOn, onChange: toggleAllLevels }),
          h('span', null, t('allLevels')),
        ),
        LEVELS.map((level) => h('label', { key: level, className: 'hl-check' },
          h('input', { type: 'checkbox', checked: levels[level] === true, onChange: () => toggleLevel(level) }),
          h('span', { className: 'hl-lv', 'data-level': level }, level),
          h('span', null, LEVEL_LABELS[level]),
        )),
        ),

        h(Dropdown, {
          className: 'hl-select',
          label: activeFilterCount === 0 ? t('filter') : `${t('filter')} · ${activeFilterCount}`,
          open: filterOpen,
          onToggle: () => setFilterOpen((value) => !value),
          onClose: () => setFilterOpen(false),
        },
        h(FilterFields, {
          t,
          initial: filters,
          onApply: (next) => {
            setFilters(next)
            setFilterOpen(false)
          },
          onClear: () => {
            setFilters({ tag: '', include: '', exclude: '' })
            setFilterOpen(false)
          },
        }),
        ),

        h('div', { className: 'hl-search-wrap' },
          h('input', {
            className: 'hl-control hl-search',
            type: 'search',
            value: query,
            placeholder: t('searchPlaceholder'),
            'aria-label': t('search'),
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                stepMatch(event.shiftKey ? -1 : 1)
              }
            },
          }),
          h('button', {
            type: 'button',
            className: 'hl-control hl-icon-btn',
            'aria-pressed': matchCase,
            title: t('matchCase'),
            'aria-label': t('matchCase'),
            onClick: () => setMatchCase((value) => !value),
          }, 'Aa'),
          h('button', {
            type: 'button',
            className: 'hl-control hl-icon-btn',
            'aria-pressed': regexMode,
            title: t('regex'),
            'aria-label': t('regex'),
            onClick: () => setRegexMode((value) => !value),
          }, '.*'),
          h('button', {
            type: 'button',
            className: 'hl-control hl-icon-btn',
            title: t('prevMatch'),
            'aria-label': t('prevMatch'),
            disabled: search.total === 0,
            onClick: () => stepMatch(-1),
          }, '↑'),
          h('button', {
            type: 'button',
            className: 'hl-control hl-icon-btn',
            title: t('nextMatch'),
            'aria-label': t('nextMatch'),
            disabled: search.total === 0,
            onClick: () => stepMatch(1),
          }, '↓'),
          searchCount,
        ),
      ),
      h('div', { className: 'hl-actionbar' },
        h('button', { className: 'hl-control', type: 'button', onClick: toggleRun }, running ? t('pause') : t('resume')),
        h('button', {
          className: 'hl-control',
          type: 'button',
          'aria-pressed': autoScroll,
          onClick: scrollToBottom,
        }, t('scrollEnd')),
        h('button', {
          className: 'hl-control',
          type: 'button',
          'aria-pressed': wrap,
          onClick: () => setWrap((value) => !value),
        }, t('softWrap')),
        h('button', {
          className: 'hl-control',
          type: 'button',
          'aria-pressed': compact,
          onClick: () => setCompact((value) => !value),
        }, compact ? t('compact') : t('standard')),
        h('button', {
          className: 'hl-control',
          type: 'button',
          disabled: visible.length === 0,
          onClick: save,
        }, t('save')),
        h('button', {
          className: 'hl-control',
          type: 'button',
          disabled: visible.length === 0,
          onClick: takeSnapshot,
        }, t('snapshot')),
        h('button', {
          className: 'hl-control',
          type: 'button',
          'aria-pressed': compareOpen,
          onClick: openCompare,
        }, t('compare')),
        h('button', {
          className: 'hl-control',
          type: 'button',
          onClick: () => {
            setLines([])
            setTotal(0)
            setError('')
          },
        }, t('clear')),
        h('label', { className: 'hl-font' },
          h('span', null, t('fontSize')),
          h('select', {
            className: 'hl-control hl-font-select',
            value: String(fontSize),
            'aria-label': t('fontSize'),
            onChange: (event) => {
              const next = Number.parseInt(event.target.value, 10)
              if (!FONT_SIZES.includes(next)) return
              setFontSize(next)
              storeFontSize(next)
            },
          }, FONT_SIZES.map((size) => h('option', { key: size, value: String(size) }, `${size}px`))),
        ),
      ),
      compareOpen ? h('section', { className: 'hl-compare' },
        h('div', { className: 'hl-compare-head' },
          h('h2', { className: 'hl-compare-title' }, t('compareTitle')),
          h('button', { className: 'hl-control', type: 'button', onClick: openCompare }, t('compareClose')),
        ),
        snapshots.length === 0
          ? h('p', { className: 'hl-compare-hint' }, t('snapshotsNone'))
          : h('div', { className: 'hl-compare-row' },
            h('label', { className: 'hl-font' },
              h('span', null, t('compareBase')),
              h('select', {
                className: 'hl-control hl-select',
                'aria-label': t('compareBase'),
                value: compareBase,
                onChange: (event) => setCompareBase(event.target.value),
              }, snapshots.map((entry) => h('option', { key: entry.id, value: entry.id }, `${entry.at} · ${entry.device} · ${entry.lines.length}`)))),
            h('label', { className: 'hl-font' },
              h('span', null, t('compareTarget')),
              h('select', {
                className: 'hl-control hl-select',
                'aria-label': t('compareTarget'),
                value: compareTarget,
                onChange: (event) => setCompareTarget(event.target.value),
              }, snapshots.map((entry) => h('option', { key: entry.id, value: entry.id }, `${entry.at} · ${entry.device} · ${entry.lines.length}`)))),
            h('button', { className: 'hl-control', type: 'button', onClick: runCompare }, t('compareRun')),
          ),
        compareResult === null ? null : h('div', { className: 'hl-diff' },
          h('div', null, compareResult.added.length === 0 && compareResult.removed.length === 0
            ? t('diffIdentical')
            : t('diffSummary', {
              added: compareResult.added.length,
              removed: compareResult.removed.length,
              same: compareResult.same,
            })),
          ...compareResult.added.slice(0, 120).map((line, index) => h('div', { key: `add-${index}`, className: 'hl-diff-add' }, `+ ${line}`)),
          ...compareResult.removed.slice(0, 120).map((line, index) => h('div', { key: `del-${index}`, className: 'hl-diff-del' }, `- ${line}`)),
          compareResult.added.length + compareResult.removed.length > 240
            ? h('div', { className: 'hl-compare-hint' }, t('diffTruncated', { n: 240 }))
            : null,
        ),
      ) : null,
      h('div', { className: 'hl-headrow' }, columns.map((key) => h('span', { key }, t(key)))),
      h('div', {
        className: 'hl-surface',
        ref: surfaceRef,
        role: 'log',
        onScroll,
      },
      visible.length === 0
        ? h('div', { className: 'hl-empty' },
          h('p', { className: 'hl-empty-title' }, t(emptyKey)),
          h('p', null, t(emptyHintKey)),
        )
        : visible.map((row) => h(Row, {
          key: row.id,
          row,
          compact,
          regex: searchRegex,
          active: activeMatch,
          base: startById.get(row.id) ?? 0,
        })),
      ),
      h('footer', { className: 'hl-foot' },
        h('span', { className: error === '' ? undefined : 'hl-foot-error' }, error === '' ? t('foot.retained', { n: lines.length }) : error),
        autoScroll
          ? null
          : h('button', { className: 'hl-control', type: 'button', onClick: scrollToBottom }, t('scrollEnd')),
      ),
      )
    }

    /**
     * One console row. The message is split by the search expression so matches
     * are highlighted; `active` marks the selected occurrence and `base` is this
     * row's first global match index.
     * @param {object} props row, view mode, search regex, active index, base index.
     * @returns {object}
     */
    function Row(props) {
      const { row, compact, regex, active, base } = props
      let occurrence = base
      const parts = []
      let last = 0

      if (regex !== null) {
        const text = row.message
        regex.lastIndex = 0
        let match
        while ((match = regex.exec(text)) !== null) {
          if (match[0] === '') {
            regex.lastIndex += 1
            continue
          }
          if (match.index > last) parts.push(text.slice(last, match.index))
          const current = occurrence
          occurrence += 1
          parts.push(h('mark', {
            key: `m${current}`,
            className: current === active ? 'hl-mark hl-mark-active' : 'hl-mark',
          }, match[0]))
          last = match.index + match[0].length
          if (parts.length > 300) break
        }
      }
      if (last < row.message.length) parts.push(row.message.slice(last))

      const level = row.level === '' ? 'C' : row.level
      const tagText = row.tag === '' ? '' : `${row.domain}/${row.tag}`

      return h('div', {
        className: 'hl-row',
        'data-level': level,
        'data-row': row.id,
      },
      h('span', { className: 'hl-cell hl-time', title: row.time }, row.time),
      compact ? null : h('span', { className: 'hl-cell hl-pid' }, String(row.pid)),
      compact ? null : h('span', { className: 'hl-cell hl-tid' }, String(row.tid)),
      h('span', { className: 'hl-cell hl-lv' }, row.level),
      h('span', { className: 'hl-cell hl-cell-tag', title: tagText }, tagText),
      h('span', { className: 'hl-cell hl-cell-msg' }, parts),
      )
    }

    /**
     * The custom-filter fields. DevEco's filter dialog exposes tag, message,
     * package and PID; the pid and level seats already live in the bar above.
     * @param {object} props translator, initial values, apply/clear callbacks.
     * @returns {object}
     */
    function FilterFields(props) {
      const { t } = props
      const [tag, setTag] = React.useState(props.initial.tag)
      const [include, setInclude] = React.useState(props.initial.include)
      const [exclude, setExclude] = React.useState(props.initial.exclude)

      return h('div', null,
        h('div', { className: 'hl-menu-title' }, t('filter')),
        h('div', { className: 'hl-field' },
          h('label', { htmlFor: 'hl-filter-tag' }, t('filterTag')),
          h('input', {
            id: 'hl-filter-tag',
            value: tag,
            placeholder: t('filterTagHint'),
            onChange: (event) => setTag(event.target.value),
          }),
        ),
        h('div', { className: 'hl-field' },
          h('label', { htmlFor: 'hl-filter-include' }, t('filterInclude')),
          h('input', {
            id: 'hl-filter-include',
            value: include,
            placeholder: t('filterIncludeHint'),
            onChange: (event) => setInclude(event.target.value),
          }),
        ),
        h('div', { className: 'hl-field' },
          h('label', { htmlFor: 'hl-filter-exclude' }, t('filterExclude')),
          h('input', {
            id: 'hl-filter-exclude',
            value: exclude,
            placeholder: t('filterExcludeHint'),
            onChange: (event) => setExclude(event.target.value),
          }),
        ),
        h('div', { className: 'hl-menu-actions' },
          h('button', { className: 'hl-control', type: 'button', onClick: props.onClear }, t('filterClear')),
          h('button', { className: 'hl-control', type: 'button', onClick: () => props.onApply({ tag, include, exclude }) }, t('filterApply')),
        ),
      )
    }

    /**
     * Sidebar icon: a console box with a chevron and two result lines.
     * @param {{ size?: number, active?: boolean }} props icon presentation.
     * @returns {object} svg element.
     */
    function PanelIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('rect', {
        x: 2.25,
        y: 2.75,
        width: 11.5,
        height: 10.5,
        rx: 2.25,
        stroke: 'currentColor',
        strokeWidth: 1.25,
      }),
      h('path', {
        d: 'M4.9 6.1 6.4 7.6 4.9 9.1',
        stroke: 'currentColor',
        strokeWidth: 1.25,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M8.2 7.6h3.2M8.2 9.8h2.2',
        stroke: 'currentColor',
        strokeWidth: 1.25,
        strokeLinecap: 'round',
      }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      // Plain-JS render internals exercised by harmony-logs-selftest.mjs; the
      // loader ignores extra plugin fields.
      __test: { Row, toRow, rowText, translator },
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'harmony-logs: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, LogsPage))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          locale: NS,
          label: () => t('panel'),
        }, PanelIcon))
      },
    }
  },
})
