import React, { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_CONFIG, DEFAULT_TRACE, addressBreakdown, formatHex, makeInitialState, normalizeConfig, parseAddress, simulateNext } from './cacheEngine.js'

const POLICY_COPY = {
  LRU: 'Evict the line that has been unused for the longest time.',
  FIFO: 'Evict the line that entered the set first.',
  Random: 'Choose a valid way at random when a set is full.'
}

function App() {
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [trace, setTrace] = useState(DEFAULT_TRACE)
  const [initialLines, setInitialLines] = useState([])
  const [state, setState] = useState(() => makeInitialState(DEFAULT_CONFIG, []))
  const [address, setAddress] = useState('0x10')
  const [selectedAddress, setSelectedAddress] = useState('0x10')
  const [speed, setSpeed] = useState(650)
  const timer = useRef(null)

  const current = state.history[state.currentStep]
  const selectedBreakdown = useMemo(() => {
    try { return addressBreakdown(selectedAddress, config) } catch { return null }
  }, [selectedAddress, config])

  const update = (key, value) => setConfig(prev => ({ ...prev, [key]: value }))
  const updateNested = (key, value) => setConfig(prev => ({ ...prev, metadata: { ...prev.metadata, [key]: value } }))

  const reset = (useInitial = true) => {
    stop()
    setState(makeInitialState(normalizeConfig(config), useInitial ? initialLines : []))
  }
  const stop = () => { if (timer.current) clearInterval(timer.current); timer.current = null }
  const advance = prev => {
    const nextIndex = prev.currentStep + 1
    if (nextIndex >= trace.length) return prev
    try {
      const base = prev.currentStep < 0 ? makeInitialState(normalizeConfig(config), initialLines) : prev
      return simulateNext(base, trace[nextIndex])
    } catch (e) {
      return { ...prev, history: [...prev.history, { step: prev.clock + 1, request: trace[nextIndex], outcome: 'error', detail: e.message, touched: [] }], currentStep: prev.currentStep + 1 }
    }
  }
  const step = () => {
    setState(prev => {
      const next = advance(prev)
      if (next !== prev) {
        const idx = next.currentStep
        if (trace[idx]) setSelectedAddress(trace[idx].address)
      }
      return next
    })
  }
  const run = () => {
    stop()
    if (state.currentStep >= trace.length - 1) { reset(true); return }
    const tick = () => {
      setState(prev => {
        if (prev.currentStep >= trace.length - 1) { stop(); return prev }
        const next = advance(prev)
        const idx = next.currentStep
        if (trace[idx]) setSelectedAddress(trace[idx].address)
        if (idx >= trace.length - 1) { stop(); return next }
        return next
      })
    }
    timer.current = setInterval(tick, speed)
    tick()
  }
  useEffect(() => () => stop(), [])

  const resetConfig = () => { stop(); setConfig(DEFAULT_CONFIG); setTrace(DEFAULT_TRACE); setInitialLines([]); setState(makeInitialState(DEFAULT_CONFIG, [])) }
  const addTrace = () => setTrace(t => [...t, { op: 'R', address: '0x00' }])
  const editTrace = (i, key, value) => setTrace(t => t.map((r, j) => j === i ? { ...r, [key]: value } : r))
  const deleteTrace = i => setTrace(t => t.filter((_, j) => j !== i))
  const addInitial = level => setInitialLines(x => [...x, { level, address: '0x00', data: '0x00' }])
  const editInitial = (i, key, value) => setInitialLines(x => x.map((r, j) => j === i ? { ...r, [key]: value } : r))
  const deleteInitial = i => setInitialLines(x => x.filter((_, j) => j !== i))

  const stats = state.stats
  const hitRate = stats.accesses ? Math.round((stats.hits / stats.accesses) * 100) : 0

  return <div className="app">
    <header className="topbar">
      <div><div className="brand">VISUAL<span>CACHE</span></div><div className="subtitle">Interactive cache visualizer</div></div>
      <div className="top-actions"><button className="ghost" onClick={resetConfig}>Reset all</button><button className="primary" onClick={() => reset(true)}>Apply configuration</button></div>
    </header>

    <main className="layout">
      <aside className="sidebar">
        <section className="panel config-panel">
          <div className="panel-title"><span>Cache configuration</span><span className="pill">L1</span></div>
          <div className="field-grid">
            <Field label="Address bits" value={config.addressBits} onChange={v => update('addressBits', Number(v))} min="4" max="32" />
            <Field label="Cache size (B)" value={config.cacheSize} onChange={v => update('cacheSize', Number(v))} min="16" step="16" />
            <Field label="Line size (B)" value={config.lineSize} onChange={v => update('lineSize', Number(v))} min="4" step="4" />
            <Field label="Associativity" value={config.associativity} onChange={v => update('associativity', Number(v))} min="1" max="16" />
          </div>
          <Select label="Eviction / replacement" value={config.replacement} onChange={v => update('replacement', v)} options={['LRU','FIFO','Random']} />
          <div className="hint">{POLICY_COPY[config.replacement]}</div>
          <label className="switch-row"><span>Enable writes</span><input type="checkbox" checked={config.enableWrites} onChange={e => update('enableWrites', e.target.checked)} /></label>
          {config.enableWrites && <>
            <Select label="Write policy" value={config.writePolicy} onChange={v => update('writePolicy', v)} options={['write-back','write-through']} />
            <label className="switch-row"><span>Write allocate</span><input type="checkbox" checked={config.writeAllocate} disabled={config.writePolicy === 'write-back'} onChange={e => update('writeAllocate', e.target.checked)} /></label>
          </>}
          <div className="section-label">Metadata shown</div>
          <div className="check-grid">
            {['valid','dirty','tag'].map(k => <label key={k}><input type="checkbox" checked={config.metadata[k]} onChange={e => updateNested(k, e.target.checked)} /> {k}</label>)}
          </div>
        </section>

        <section className="panel">
          <div className="panel-title"><span>L2 cache</span><input className="toggle" type="checkbox" checked={config.enableL2} onChange={e => update('enableL2', e.target.checked)} /></div>
          {config.enableL2 ? <>
            <div className="field-grid">
              <Field label="Size (B)" value={config.l2Size} onChange={v => update('l2Size', Number(v))} />
              <Field label="Line size (B)" value={config.l2LineSize} onChange={v => update('l2LineSize', Number(v))} />
              <Field label="Associativity" value={config.l2Associativity} onChange={v => update('l2Associativity', Number(v))} />
            </div>
            <Select label="Replacement" value={config.l2Replacement} onChange={v => update('l2Replacement', v)} options={['LRU','FIFO','Random']} />
          </> : <div className="hint">Disabled. L1 misses fetch directly from memory.</div>}
        </section>

        <section className="panel">
          <div className="panel-title"><span>Initial cache state</span></div>
          <div className="segmented"><button className={initialLines.length === 0 ? 'active' : ''} onClick={() => setInitialLines([])}>Cold / empty</button><button className={initialLines.length ? 'active' : ''} onClick={() => { if (!initialLines.length) addInitial('L1') }}>Pre-filled</button></div>
          {initialLines.length > 0 && <div className="initial-list">
            {initialLines.map((r, i) => <div className="mini-row" key={i}><select value={r.level} onChange={e => editInitial(i, 'level', e.target.value)}><option>L1</option>{config.enableL2 && <option>L2</option>}</select><input value={r.address} onChange={e => editInitial(i,'address',e.target.value)} aria-label="Initial address"/><input value={r.data} onChange={e => editInitial(i,'data',e.target.value)} aria-label="Initial data"/><button className="icon-btn" onClick={() => deleteInitial(i)}>×</button></div>)}
            <button className="text-btn" onClick={() => addInitial('L1')}>+ Add line</button>
          </div>}
          {initialLines.length === 0 && <button className="text-btn" onClick={() => addInitial('L1')}>+ Add pre-filled line</button>}
        </section>

        <section className="panel trace-panel">
          <div className="panel-title"><span>Memory request trace</span><span className="count">{trace.length}</span></div>
          <div className="trace-list">
            {trace.map((r, i) => <div className="trace-row" key={i}><span className="trace-num">{i+1}</span><select value={r.op} onChange={e => editTrace(i,'op',e.target.value)}><option>R</option><option>W</option></select><input value={r.address} onChange={e => editTrace(i,'address',e.target.value)} /><button className="icon-btn" onClick={() => deleteTrace(i)}>×</button>{r.op==='W' && <input className="data-input" value={r.data || ''} placeholder="data" onChange={e => editTrace(i,'data',e.target.value)} />}</div>)}
          </div>
          <button className="text-btn" onClick={addTrace}>+ Add memory request</button>
        </section>
      </aside>

      <section className="workspace">
        <div className="controlbar">
          <div className="request-box"><span>Next request</span><input value={address} onChange={e => setAddress(e.target.value)} /><select defaultValue="R"><option>R</option><option>W</option></select><button className="small-btn" onClick={() => { setTrace(t => [...t, { op: 'R', address }]); setSelectedAddress(address) }}>Queue</button></div>
          <div className="transport"><button className="transport-btn" onClick={() => { reset(true); }} title="Reset">↺</button><button className="transport-btn play" onClick={run}>▶</button><button className="transport-btn" onClick={stop}>Ⅱ</button><button className="transport-btn" onClick={step}>›</button><label className="speed">{speed}ms<input type="range" min="250" max="1400" step="50" value={speed} onChange={e => setSpeed(Number(e.target.value))}/></label></div>
        </div>

        <div className="statusbar">
          <div><strong>{current ? current.request.address : 'Ready'}</strong><span>{current?.outcome === 'hit' ? 'HIT' : current?.outcome === 'miss' ? 'MISS' : 'Waiting for request'}</span></div>
          <div className="status-detail">{current?.detail || 'Configure the cache, then step through the request trace.'}</div>
          <div className="stats"><span>Hit rate <b>{hitRate}%</b></span><span>Evictions <b>{stats.evictions}</b></span><span>Writebacks <b>{stats.writebacks}</b></span></div>
        </div>

        <div className="address-strip">
          <div className="address-title">Address decomposition</div>
          {selectedBreakdown ? <div className="bits"><div className="bit-group tag"><small>TAG · {selectedBreakdown.tagBits} bits</small><b>{selectedBreakdown.tag.toString(2).padStart(Math.max(1,selectedBreakdown.tagBits),'0')}</b></div><div className="bit-group index"><small>SET · {selectedBreakdown.indexBits} bits</small><b>{selectedBreakdown.set.toString(2).padStart(Math.max(1,selectedBreakdown.indexBits),'0')}</b></div><div className="bit-group offset"><small>OFFSET · {selectedBreakdown.offsetBits} bits</small><b>{selectedBreakdown.offset.toString(2).padStart(Math.max(1,selectedBreakdown.offsetBits),'0')}</b></div><div className="binary">{selectedBreakdown.binary}</div></div> : <div className="hint">Enter a valid address to see the tag, set, and offset.</div>}
        </div>

        <CacheView cache={state.l1} touched={current?.touched || []} metadata={config.metadata} />
        {config.enableL2 && state.l2 && <CacheView cache={state.l2} touched={current?.touched || []} metadata={config.metadata} />}

        <div className="lower-grid">
          <section className="panel timeline-panel"><div className="panel-title"><span>Execution timeline</span><span className="count">{state.history.length}/{trace.length}</span></div><div className="timeline">{state.history.map((h, i) => <button key={i} className={`timeline-item ${i===state.currentStep?'selected':''} ${h.outcome==='hit'?'hit':'miss'}`} onClick={() => { setSelectedAddress(h.request.address); }}><span>{i+1}</span><b>{h.request.op}</b><em>{h.request.address}</em><strong>{h.outcome}</strong></button>)}{!state.history.length && <div className="empty">No requests executed yet.</div>}</div></section>
          <section className="panel explanation"><div className="panel-title"><span>What happened?</span></div>{current ? <><div className="event-head"><span className={`event-badge ${current.outcome}`}>{current.outcome}</span><b>{current.action}</b></div><p>{current.detail}</p><div className="event-facts">{current.way !== null && <Fact label="L1 way" value={current.way}/>}<Fact label="Set" value={current.parts?.set ?? '—'}/><Fact label="Tag" value={current.parts?.tag !== undefined ? formatHex(current.parts.tag, config.addressBits) : '—'}/>{current.l2Outcome && <Fact label="L2" value={current.l2Outcome}/>} {current.writeback !== null && <Fact label="Writeback" value={formatHex(current.writeback, config.addressBits)}/>}</div></> : <p className="muted">Step through the trace to see why each request hits, misses, fills, or evicts.</p>}</section>
        </div>
      </section>
    </main>
  </div>
}

function CacheView({ cache, touched, metadata }) {
  return <section className="cache-section"><div className="cache-header"><div><h2>{cache.name}</h2><span>{cache.size} B · {cache.lineSize} B lines · {cache.associativity}-way · {cache.geometry.sets} sets</span></div><div className="legend"><span><i className="dot empty-dot"/>empty</span><span><i className="dot hit-dot"/>accessed</span><span><i className="dot evict-dot"/>eviction</span></div></div><div className="cache-scroll"><div className="cache-grid" style={{gridTemplateColumns:`54px repeat(${cache.associativity}, minmax(150px, 1fr))`}}><div className="grid-head">SET</div>{Array.from({length:cache.associativity},(_,i)=><div className="grid-head" key={i}>WAY {i}</div>)}{cache.sets.map((set, si) => <React.Fragment key={si}><div className="set-label">{si}<small>0x{(si*cache.lineSize).toString(16).toUpperCase()}</small></div>{set.map((line, wi) => { const hit = touched.some(t => t.level===cache.name && t.set===si && t.way===wi); return <div className={`cache-line ${line.valid?'filled':'empty'} ${hit?'touched':''}`} key={wi}><div className="line-main"><div className="line-top"><span className="valid-mark">{line.valid ? '●' : '○'}</span>{metadata.tag && <span>TAG {line.valid ? line.tag : '—'}</span>}<span className="way-state">{line.valid ? (line.dirty ? 'DIRTY' : 'CLEAN') : 'EMPTY'}</span></div><div className="line-data">{line.valid ? line.data || 'data' : '—'}</div></div><div className="line-meta">{metadata.valid && <span>V {line.valid?1:0}</span>}{metadata.dirty && <span>D {line.dirty?1:0}</span>}</div></div>})}</React.Fragment>)}</div></div></section>
}

function Field({label,value,onChange,min, max, step}) { return <label className="field"><span>{label}</span><input type="number" value={value} min={min} max={max} step={step} onChange={e=>onChange(e.target.value)}/></label> }
function Select({label,value,onChange,options}) { return <label className="field"><span>{label}</span><select value={value} onChange={e=>onChange(e.target.value)}>{options.map(o=><option key={o}>{o}</option>)}</select></label> }
function Fact({label,value}) { return <div><span>{label}</span><b>{value}</b></div> }

export default App
