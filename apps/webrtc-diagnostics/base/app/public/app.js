const ui = {
  auto: document.querySelector('#run-auto'),
  relay: document.querySelector('#run-relay'),
  copy: document.querySelector('#copy-json'),
  dot: document.querySelector('#status-dot'),
  label: document.querySelector('#status-label'),
  detail: document.querySelector('#status-detail'),
  pair: document.querySelector('#pair-details'),
  test: document.querySelector('#test-details'),
  servers: document.querySelector('#ice-server-list'),
  candidates: document.querySelector('#candidate-list'),
}

let active = null
let lastReport = null

function setStatus(kind, label, detail) {
  ui.dot.className = `status-dot ${kind}`
  ui.label.textContent = label
  ui.detail.textContent = detail
}

function rows(target, entries) {
  target.replaceChildren()
  for (const [key, value] of entries) {
    const dt = document.createElement('dt')
    const dd = document.createElement('dd')
    dt.textContent = key
    dd.textContent = value ?? '—'
    target.append(dt, dd)
  }
}

function configuredEndpoints(iceServers = []) {
  const endpoints = []
  for (const server of iceServers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
    for (const url of urls.filter(Boolean)) {
      const scheme = url.slice(0, url.indexOf(':')).toLowerCase()
      const explicitTransport = url.match(/[?&]transport=([^&]+)/i)?.[1]
      endpoints.push({
        type: scheme === 'turns' ? 'TURN/TLS' : scheme.toUpperCase(),
        transport: (explicitTransport ?? (scheme.endsWith('s') ? 'tcp' : 'udp')).toUpperCase(),
        url,
      })
    }
  }
  return endpoints
}

function renderEndpoints(endpoints, errors = []) {
  ui.servers.replaceChildren()
  if (endpoints.length === 0) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 4
    cell.textContent = 'No ICE endpoints were configured.'
    row.append(cell)
    ui.servers.append(row)
    return
  }
  for (const endpoint of endpoints) {
    const failure = [...errors].reverse().find((error) => error.url === endpoint.url)
    const row = document.createElement('tr')
    const values = [
      endpoint.type,
      endpoint.transport,
      endpoint.url,
      failure ? `${failure.errorCode}: ${failure.errorText}` : 'No error observed',
    ]
    for (const [index, value] of values.entries()) {
      const cell = document.createElement('td')
      cell.textContent = value
      if (failure && index === 3) cell.className = 'endpoint-error'
      row.append(cell)
    }
    ui.servers.append(row)
  }
}

function waitForIceGathering(pc, timeoutMs = 20_000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const timer = window.setTimeout(done, timeoutMs)
    function done() {
      window.clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', changed)
      resolve()
    }
    function changed() {
      if (pc.iceGatheringState === 'complete') done()
    }
    pc.addEventListener('icegatheringstatechange', changed)
  })
}

function waitForOpen(channel, pc, timeoutMs = 25_000) {
  if (channel.readyState === 'open') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error('WebRTC connection timed out')), timeoutMs)
    function finish(error) {
      window.clearTimeout(timer)
      channel.removeEventListener('open', opened)
      pc.removeEventListener('connectionstatechange', changed)
      error ? reject(error) : resolve()
    }
    function opened() { finish() }
    function changed() {
      if (['failed', 'closed'].includes(pc.connectionState)) finish(new Error(`WebRTC peer ${pc.connectionState}`))
    }
    channel.addEventListener('open', opened)
    pc.addEventListener('connectionstatechange', changed)
  })
}

function ping(channel) {
  return new Promise((resolve, reject) => {
    const payload = `path-diagnostic:${crypto.randomUUID()}`
    const started = performance.now()
    const timer = window.setTimeout(() => finish(new Error('Data-channel echo timed out')), 5000)
    function finish(error) {
      window.clearTimeout(timer)
      channel.removeEventListener('message', message)
      error ? reject(error) : resolve(Math.round((performance.now() - started) * 10) / 10)
    }
    function message(event) {
      if (event.data === payload) finish()
    }
    channel.addEventListener('message', message)
    channel.send(payload)
  })
}

function candidateFromEvent(candidate, peer) {
  return {
    peer,
    type: candidate.type,
    protocol: candidate.protocol,
    address: candidate.address,
    port: candidate.port,
    relatedAddress: candidate.relatedAddress,
    relatedPort: candidate.relatedPort,
    relayProtocol: candidate.relayProtocol,
    url: candidate.url,
    candidate: candidate.candidate,
  }
}

function candidateFromSdp(value, peer) {
  const candidate = new RTCIceCandidate(value)
  return candidateFromEvent(candidate, peer)
}

async function selectedPair(pc) {
  const stats = await pc.getStats()
  let pair = null
  for (const item of stats.values()) {
    if (item.type === 'transport' && item.selectedCandidatePairId) pair = stats.get(item.selectedCandidatePairId)
  }
  if (!pair) {
    for (const item of stats.values()) {
      if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated) pair = item
    }
  }
  if (!pair) return null
  const mapCandidate = (candidate) => candidate ? {
    type: candidate.candidateType,
    protocol: candidate.protocol,
    address: candidate.address ?? candidate.ip,
    port: candidate.port,
    relatedAddress: candidate.relatedAddress,
    relatedPort: candidate.relatedPort,
    relayProtocol: candidate.relayProtocol,
    url: candidate.url,
  } : null
  return {
    state: pair.state,
    nominated: pair.nominated,
    rttMs: typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 10_000) / 10 : null,
    bytesSent: pair.bytesSent,
    bytesReceived: pair.bytesReceived,
    local: mapCandidate(stats.get(pair.localCandidateId)),
    remote: mapCandidate(stats.get(pair.remoteCandidateId)),
  }
}

function verdict(pair) {
  const types = [pair?.local?.type, pair?.remote?.type]
  if (types.includes('relay')) {
    const relay = pair.local?.type === 'relay' ? pair.local : pair.remote
    const transport = relay?.relayProtocol ?? relay?.protocol ?? 'unknown transport'
    return { kind: 'relay', label: 'Relayed through TURN', detail: `The nominated ICE pair uses a relay candidate over ${transport}.` }
  }
  if (types.includes('srflx') || types.includes('prflx')) {
    return { kind: 'direct', label: 'Direct NAT-traversed path', detail: 'STUN/ICE established the nominated pair without relaying application traffic.' }
  }
  if (types.every((type) => type === 'host')) {
    return { kind: 'direct', label: 'Direct host path', detail: 'The nominated pair uses host candidates; no TURN relay is carrying the data.' }
  }
  return { kind: 'direct', label: 'Direct path selected', detail: 'The nominated pair does not contain a TURN relay candidate.' }
}

function renderCandidates(candidates) {
  ui.candidates.replaceChildren()
  if (candidates.length === 0) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 6
    cell.textContent = 'No candidates were gathered.'
    row.append(cell)
    ui.candidates.append(row)
    return
  }
  for (const candidate of candidates) {
    const row = document.createElement('tr')
    const values = [
      candidate.peer,
      candidate.type ?? 'unknown',
      [candidate.protocol, candidate.relayProtocol].filter(Boolean).join(' / ') || '—',
      candidate.address ? `${candidate.address}:${candidate.port ?? ''}` : 'hidden',
      candidate.relatedAddress ? `${candidate.relatedAddress}:${candidate.relatedPort ?? ''}` : '—',
      candidate.url ?? '—',
    ]
    for (const value of values) {
      const cell = document.createElement('td')
      cell.textContent = value
      row.append(cell)
    }
    ui.candidates.append(row)
  }
}

async function stopActive() {
  if (!active) return
  const { pc, sessionId } = active
  active = null
  pc.close()
  if (sessionId) await fetch(`/api/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {})
}

async function run(policy = 'all') {
  await stopActive()
  ui.auto.disabled = true
  ui.relay.disabled = true
  ui.copy.disabled = true
  lastReport = null
  const startedAt = new Date()
  const candidates = []
  const iceErrors = []
  let endpoints = []
  setStatus('pending', policy === 'relay' ? 'Testing forced TURN…' : 'Testing automatic ICE path…', 'Gathering candidates from both peers.')
  rows(ui.pair, [['Status', 'Negotiating']])
  rows(ui.test, [['Mode', policy === 'relay' ? 'Relay only' : 'Automatic fallback'], ['Started', startedAt.toLocaleTimeString()]])
  renderEndpoints(endpoints, iceErrors)
  renderCandidates(candidates)

  let pc
  try {
    const configResponse = await fetch('/api/config', { cache: 'no-store' })
    if (!configResponse.ok) throw new Error(`ICE configuration failed: HTTP ${configResponse.status}`)
    const config = await configResponse.json()
    endpoints = configuredEndpoints(config.iceServers)
    renderEndpoints(endpoints, iceErrors)
    if (policy === 'relay' && !config.turnConfigured) throw new Error('Cloudflare TURN is not configured or credential minting failed')

    pc = new RTCPeerConnection({ iceServers: config.iceServers, iceTransportPolicy: policy })
    active = { pc, sessionId: null }
    pc.addEventListener('icecandidateerror', (event) => {
      iceErrors.push({
        url: event.url,
        address: event.address,
        port: event.port,
        errorCode: event.errorCode,
        errorText: event.errorText,
      })
      renderEndpoints(endpoints, iceErrors)
    })
    pc.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return
      candidates.push(candidateFromEvent(event.candidate, 'browser'))
      renderCandidates(candidates)
    })
    const channel = pc.createDataChannel('path-diagnostic', { ordered: true })
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await waitForIceGathering(pc)

    const offerResponse = await fetch('/api/offer', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }),
    })
    const answerBody = await offerResponse.json()
    if (!offerResponse.ok) throw new Error(answerBody.error ?? `Offer failed: HTTP ${offerResponse.status}`)
    active.sessionId = answerBody.sessionId
    for (const candidate of answerBody.serverCandidates ?? []) {
      try { candidates.push(candidateFromSdp(candidate, 'cluster')) } catch { /* retain the connection even if a browser cannot parse one server candidate */ }
    }
    renderCandidates(candidates)
    await pc.setRemoteDescription(answerBody.answer)
    await waitForOpen(channel, pc)
    const echoRttMs = await ping(channel)
    await new Promise((resolve) => window.setTimeout(resolve, 200))
    const pair = await selectedPair(pc)
    if (!pair) throw new Error('Connected, but the browser did not expose a selected ICE candidate pair')
    const result = verdict(pair)
    setStatus(result.kind, result.label, result.detail)
    rows(ui.pair, [
      ['Local', `${pair.local?.type ?? 'unknown'} · ${pair.local?.protocol ?? '—'} · ${pair.local?.address ?? 'hidden'}:${pair.local?.port ?? ''}`],
      ['Remote', `${pair.remote?.type ?? 'unknown'} · ${pair.remote?.protocol ?? '—'} · ${pair.remote?.address ?? 'hidden'}:${pair.remote?.port ?? ''}`],
      ['ICE server', pair.local?.url ?? pair.remote?.url ?? 'Not reported'],
      ['ICE RTT', pair.rttMs == null ? 'Not reported' : `${pair.rttMs} ms`],
      ['Echo RTT', `${echoRttMs} ms`],
      ['Traffic', `${pair.bytesSent ?? 0} B sent / ${pair.bytesReceived ?? 0} B received`],
    ])
    rows(ui.test, [
      ['Mode', policy === 'relay' ? 'Relay only' : 'Automatic fallback'],
      ['TURN configured', config.turnConfigured ? 'Yes' : 'No — STUN only'],
      ['Peer state', pc.connectionState],
      ['ICE state', pc.iceConnectionState],
      ['Configured endpoints', String(endpoints.length)],
      ['Candidates', String(candidates.length)],
      ['ICE server errors', String(iceErrors.length)],
      ['Completed', new Date().toLocaleTimeString()],
    ])
    lastReport = { startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), policy, config: { turnConfigured: config.turnConfigured, warning: config.warning, endpoints }, verdict: result, pair, echoRttMs, candidates, iceErrors }
    ui.copy.disabled = false
  } catch (error) {
    setStatus('failed', 'Diagnostic failed', error instanceof Error ? error.message : String(error))
    rows(ui.pair, [['Status', 'No nominated pair']])
    rows(ui.test, [['Mode', policy === 'relay' ? 'Relay only' : 'Automatic fallback'], ['Error', error instanceof Error ? error.message : String(error)]])
    lastReport = { startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), policy, error: error instanceof Error ? error.message : String(error), endpoints, candidates, iceErrors }
    ui.copy.disabled = false
  } finally {
    ui.auto.disabled = false
    ui.relay.disabled = false
  }
}

ui.auto.addEventListener('click', () => void run('all'))
ui.relay.addEventListener('click', () => void run('relay'))
ui.copy.addEventListener('click', async () => {
  if (!lastReport) return
  await navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2))
  const original = ui.copy.textContent
  ui.copy.textContent = 'Copied'
  window.setTimeout(() => { ui.copy.textContent = original }, 1200)
})
window.addEventListener('beforeunload', () => {
  if (active?.sessionId) void fetch(`/api/session/${encodeURIComponent(active.sessionId)}`, { method: 'DELETE', keepalive: true })
  active?.pc.close()
})

void run('all')
