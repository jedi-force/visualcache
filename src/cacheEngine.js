export const DEFAULT_TRACE = [
  { op: 'R', address: '0x10' },
  { op: 'R', address: '0x30' },
  { op: 'R', address: '0x50' },
  { op: 'W', address: '0x10', data: '0xAA' },
  { op: 'R', address: '0x90' },
  { op: 'R', address: '0x30' },
  { op: 'R', address: '0xD0' },
  { op: 'R', address: '0x10' }
]

export const DEFAULT_CONFIG = {
  addressBits: 8,
  cacheSize: 64,
  lineSize: 16,
  associativity: 2,
  replacement: 'LRU',
  writePolicy: 'write-back',
  writeAllocate: true,
  enableWrites: true,
  enableL2: true,
  l2Size: 128,
  l2LineSize: 16,
  l2Associativity: 2,
  l2Replacement: 'LRU',
  metadata: { valid: true, dirty: true, tag: true },
  initialMode: 'cold'
}

const pow2 = n => 2 ** n

export function normalizeConfig(raw) {
  const c = { ...DEFAULT_CONFIG, ...raw, metadata: { ...DEFAULT_CONFIG.metadata, ...(raw.metadata || {}) } }
  c.addressBits = clampInt(c.addressBits, 4, 32)
  c.cacheSize = clampPow2(c.cacheSize, 16, 1 << Math.min(24, c.addressBits))
  c.lineSize = clampPow2(c.lineSize, 4, c.cacheSize)
  c.associativity = clampInt(c.associativity, 1, Math.min(16, c.cacheSize / c.lineSize))
  c.l2Size = clampPow2(c.l2Size, 16, 1 << Math.min(26, c.addressBits))
  c.l2LineSize = clampPow2(c.l2LineSize, 4, c.l2Size)
  c.l2Associativity = clampInt(c.l2Associativity, 1, Math.min(16, c.l2Size / c.l2LineSize))
  c.writePolicy = c.enableWrites ? c.writePolicy : 'write-through'
  if (c.writePolicy === 'write-back') c.writeAllocate = true
  return c
}

function clampInt(v, min, max) {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min
}

function clampPow2(v, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return min
  const p = 2 ** Math.round(Math.log2(Math.min(max, Math.max(min, n))))
  return Math.min(max, Math.max(min, p))
}

export function parseAddress(value, bits = 8) {
  const s = String(value ?? '').trim()
  if (!s) throw new Error('Address is empty.')
  const n = /^0x/i.test(s) ? Number.parseInt(s.slice(2), 16) : Number(s)
  const max = 2 ** bits
  if (!Number.isInteger(n) || n < 0 || n >= max) throw new Error(`Address ${s} must be between 0 and ${max - 1}.`)
  return n
}

export function formatHex(n, bits = 8) {
  const digits = Math.max(2, Math.ceil(bits / 4))
  return `0x${n.toString(16).toUpperCase().padStart(digits, '0')}`
}

function geometry(size, lineSize, associativity) {
  const lines = Math.floor(size / lineSize)
  const sets = Math.max(1, Math.floor(lines / associativity))
  const offsetBits = Math.log2(lineSize)
  const indexBits = Math.log2(sets)
  return { lines, sets, offsetBits, indexBits, tagBits: null }
}

function splitAddress(address, g, bits) {
  const offset = address % (2 ** g.offsetBits)
  const block = Math.floor(address / (2 ** g.offsetBits))
  const set = block % g.sets
  const tag = Math.floor(block / g.sets)
  return { offset, set, tag, block }
}

function makeCache(name, size, lineSize, associativity, replacement, bits, metadata) {
  const g = geometry(size, lineSize, associativity)
  g.tagBits = bits - g.indexBits - g.offsetBits
  return {
    name, size, lineSize, associativity, replacement, metadata, geometry: g,
    sets: Array.from({ length: g.sets }, () => Array.from({ length: associativity }, () => emptyLine()))
  }
}

function emptyLine() {
  return { valid: false, dirty: false, tag: null, block: null, data: null, lastUsed: 0, inserted: 0 }
}

function cloneCache(c) {
  return { ...c, geometry: { ...c.geometry }, sets: c.sets.map(set => set.map(line => ({ ...line }))) }
}

function chooseVictim(set, policy, clock) {
  const invalid = set.findIndex(l => !l.valid)
  if (invalid >= 0) return { index: invalid, reason: 'empty-way' }
  if (policy === 'FIFO') {
    let idx = 0
    for (let i = 1; i < set.length; i++) if (set[i].inserted < set[idx].inserted) idx = i
    return { index: idx, reason: 'fifo' }
  }
  if (policy === 'Random') return { index: Math.floor(Math.random() * set.length), reason: 'random' }
  let idx = 0
  for (let i = 1; i < set.length; i++) if (set[i].lastUsed < set[idx].lastUsed) idx = i
  return { index: idx, reason: 'lru' }
}

function findLine(cache, parts) {
  return cache.sets[parts.set].findIndex(l => l.valid && l.tag === parts.tag)
}

function install(cache, address, data, clock, initial = false) {
  const p = splitAddress(address, cache.geometry, 32)
  const set = cache.sets[p.set]
  const victim = chooseVictim(set, cache.replacement, clock)
  const line = set[victim.index]
  const evicted = line.valid ? { ...line, address: line.block * cache.lineSize } : null
  set[victim.index] = {
    valid: true, dirty: false, tag: p.tag, block: p.block, data,
    lastUsed: clock, inserted: initial ? clock : clock
  }
  return { way: victim.index, evicted }
}

export function makeInitialState(config, initialLines = []) {
  const c = normalizeConfig(config)
  const state = {
    config: c,
    l1: makeCache('L1', c.cacheSize, c.lineSize, c.associativity, c.replacement, c.addressBits, c.metadata),
    l2: c.enableL2 ? makeCache('L2', c.l2Size, c.l2LineSize, c.l2Associativity, c.l2Replacement, c.addressBits, c.metadata) : null,
    memory: new Map(), clock: 0,
    stats: { accesses: 0, hits: 0, misses: 0, evictions: 0, writebacks: 0, l2Hits: 0, l2Misses: 0 },
    history: [], currentStep: -1
  }
  initialLines.forEach((entry, i) => {
    try {
      const address = parseAddress(entry.address, c.addressBits)
      const data = entry.data || formatHex((address * 13) & 255, 8)
      const target = entry.level === 'L2' && state.l2 ? state.l2 : state.l1
      install(target, address, data, i + 1, true)
    } catch { /* invalid initial rows are ignored by design; UI validates them */ }
  })
  return state
}

function dataFor(memory, address) {
  if (!memory.has(address)) memory.set(address, formatHex((address * 13 + 7) & 255, 8))
  return memory.get(address)
}

function writeMemory(memory, address, data) { memory.set(address, data || formatHex((address * 17 + 3) & 255, 8)) }

export function simulateNext(previous, request) {
  const state = cloneState(previous)
  const c = state.config
  const address = parseAddress(request.address, c.addressBits)
  const parts = splitAddress(address, state.l1.geometry, c.addressBits)
  const step = state.clock + 1
  state.clock = step
  state.stats.accesses++
  const event = {
    step, request: { ...request, address: formatHex(address, c.addressBits) }, address,
    parts, level: 'L1', outcome: 'miss', action: 'fill', way: null, evicted: null,
    l2Outcome: null, writeback: null, detail: '', touched: [], memoryWrite: null
  }

  const l1 = state.l1
  const idx = findLine(l1, parts)
  if (idx >= 0) {
    const line = l1.sets[parts.set][idx]
    state.stats.hits++
    event.outcome = 'hit'; event.action = request.op === 'W' ? 'write' : 'read'; event.way = idx
    line.lastUsed = step
    event.touched.push({ level: 'L1', set: parts.set, way: idx, kind: request.op === 'W' ? 'write' : 'hit' })
    if (request.op === 'W') {
      line.data = request.data || formatHex((address * 29) & 255, 8)
      if (c.writePolicy === 'write-back') line.dirty = true
      else { writeMemory(state.memory, address, line.data); event.memoryWrite = line.data }
    }
    event.detail = `L1 hit in set ${parts.set}, way ${idx}.`
    state.history.push(event); state.currentStep = state.history.length - 1
    return state
  }

  state.stats.misses++
  if (c.enableL2 && state.l2) {
    const lp = splitAddress(address, state.l2.geometry, c.addressBits)
    const li = findLine(state.l2, lp)
    if (li >= 0) {
      state.stats.l2Hits++
      const l2line = state.l2.sets[lp.set][li]
      l2line.lastUsed = step
      event.l2Outcome = 'hit'
      event.touched.push({ level: 'L2', set: lp.set, way: li, kind: 'hit' })
      const installed = install(l1, address, l2line.data || dataFor(state.memory, address), step)
      event.way = installed.way; event.evicted = installed.evicted
      event.touched.push({ level: 'L1', set: parts.set, way: installed.way, kind: 'fill' })
      if (installed.evicted) {
        state.stats.evictions++
        if (installed.evicted.dirty && c.writePolicy === 'write-back') {
          state.stats.writebacks++; writeMemory(state.memory, installed.evicted.address, installed.evicted.data); event.writeback = installed.evicted.address
        }
      }
      if (request.op === 'W') {
        const data = request.data || formatHex((address * 29) & 255, 8)
        const nl = l1.sets[parts.set][installed.way]
        nl.data = data
        if (c.writePolicy === 'write-back') nl.dirty = true
        else { writeMemory(state.memory, address, data); event.memoryWrite = data }
      }
      event.outcome = 'miss'; event.action = 'L2→L1 fill'; event.detail = `L1 miss, L2 hit. Block copied into L1 set ${parts.set}.`
      state.history.push(event); state.currentStep = state.history.length - 1
      return state
    }
    state.stats.l2Misses++; event.l2Outcome = 'miss'
    const l2parts = lp
    const l2installed = install(state.l2, address, dataFor(state.memory, address), step)
    event.touched.push({ level: 'L2', set: l2parts.set, way: l2installed.way, kind: 'fill' })
  }

  const installed = install(l1, address, dataFor(state.memory, address), step)
  event.way = installed.way; event.evicted = installed.evicted
  event.touched.push({ level: 'L1', set: parts.set, way: installed.way, kind: 'fill' })
  if (installed.evicted) {
    state.stats.evictions++
    if (installed.evicted.dirty && c.writePolicy === 'write-back') {
      state.stats.writebacks++; writeMemory(state.memory, installed.evicted.address, installed.evicted.data); event.writeback = installed.evicted.address
    }
  }

  if (request.op === 'W') {
    const data = request.data || formatHex((address * 29) & 255, 8)
    if (c.writeAllocate) {
      const line = l1.sets[parts.set][installed.way]
      line.data = data
      if (c.writePolicy === 'write-back') line.dirty = true
      else { writeMemory(state.memory, address, data); event.memoryWrite = data }
    } else {
      writeMemory(state.memory, address, data); event.memoryWrite = data; event.action = 'write around'
    }
  }
  event.action = request.op === 'W' && !c.writeAllocate ? 'write around' : 'memory→L1 fill'
  event.detail = `L1 miss${c.enableL2 ? ', L2 miss' : ''}. Block fetched from memory.`
  state.history.push(event); state.currentStep = state.history.length - 1
  return state
}

function cloneState(s) {
  return {
    ...s, config: { ...s.config, metadata: { ...s.config.metadata } },
    l1: cloneCache(s.l1), l2: s.l2 ? cloneCache(s.l2) : null,
    memory: new Map(s.memory), stats: { ...s.stats }, history: [...s.history]
  }
}

export function runTrace(config, trace, initialLines = []) {
  let state = makeInitialState(config, initialLines)
  const snapshots = [state]
  for (const request of trace) {
    try { state = simulateNext(state, request); snapshots.push(state) } catch (error) {
      state = { ...state, history: [...state.history, { step: state.clock + 1, request, outcome: 'error', detail: error.message, touched: [] }] }
      snapshots.push(state)
    }
  }
  return snapshots
}

export function addressBreakdown(address, config, level = 'L1') {
  const c = normalizeConfig(config)
  const cache = level === 'L2' && c.enableL2
    ? makeCache('L2', c.l2Size, c.l2LineSize, c.l2Associativity, c.l2Replacement, c.addressBits, c.metadata)
    : makeCache('L1', c.cacheSize, c.lineSize, c.associativity, c.replacement, c.addressBits, c.metadata)
  const n = parseAddress(address, c.addressBits)
  const p = splitAddress(n, cache.geometry, c.addressBits)
  return { ...p, ...cache.geometry, address: n, binary: n.toString(2).padStart(c.addressBits, '0') }
}
