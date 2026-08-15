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
  browserTopology: document.querySelector('#browser-topology'),
  pathTopology: document.querySelector('#path-topology'),
  clusterTopology: document.querySelector('#cluster-topology'),
  findings: document.querySelector('#network-findings'),
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
      const endpoint = {
        id: `endpoint-${endpoints.length}`,
        type: scheme === 'turns' ? 'TURN/TLS' : scheme.toUpperCase(),
        transport: (explicitTransport ?? (scheme.endsWith('s') ? 'tcp' : 'udp')).toUpperCase(),
        url,
      }
      Object.defineProperty(endpoint, 'iceServer', {
        enumerable: false,
        value: { urls: [url], username: server.username, credential: server.credential },
      })
      endpoints.push(endpoint)
    }
  }
  return endpoints
}

function renderEndpoints(endpoints, errors = [], checks = []) {
  const checkByID = new Map(checks.map((check) => [check.id, check]))
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
    const check = checkByID.get(endpoint.id)
    const failure = [...errors].reverse().find((error) => error.url === endpoint.url)
    let result = 'Testing…'
    if (check?.status === 'passed') {
      const transports = check.relayProtocols.length > 0 ? `; relay control ${check.relayProtocols.join(', ')}` : ''
      result = `${check.candidateTypes.join(', ')} candidate in ${check.elapsedMs} ms${transports}`
    } else if (check?.status === 'failed') {
      result = check.error ?? 'No expected candidate gathered'
    } else if (check?.status === 'inconclusive') {
      result = `No expected candidate before ${check.elapsedMs} ms${check.timedOut ? ' timeout' : ''}`
    } else if (failure) {
      result = `${failure.errorCode}: ${failure.errorText}`
    }
    const row = document.createElement('tr')
    const values = [
      endpoint.type,
      endpoint.transport,
      endpoint.url,
      result,
    ]
    for (const [index, value] of values.entries()) {
      const cell = document.createElement('td')
      cell.textContent = value
      if ((failure || check?.status === 'failed') && index === 3) cell.className = 'endpoint-error'
      row.append(cell)
    }
    ui.servers.append(row)
  }
}

function waitForIceGathering(pc, timeoutMs = 20_000) {
  const started = performance.now()
  if (pc.iceGatheringState === 'complete') return Promise.resolve({ timedOut: false, elapsedMs: 0 })
  return new Promise((resolve) => {
    let finished = false
    const timer = window.setTimeout(() => done(true), timeoutMs)
    function done(timedOut = false) {
      if (finished) return
      finished = true
      window.clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', changed)
      resolve({ timedOut, elapsedMs: Math.round(performance.now() - started) })
    }
    function changed() {
      if (pc.iceGatheringState === 'complete') done(false)
    }
    pc.addEventListener('icegatheringstatechange', changed)
    changed()
  })
}

async function checkEndpoint(endpoint, timeoutMs = 8_000) {
  const started = performance.now()
  const gathered = []
  const errors = []
  const wantsRelay = endpoint.type.startsWith('TURN')
  let pc
  try {
    pc = new RTCPeerConnection({
      iceServers: [endpoint.iceServer],
      iceTransportPolicy: wantsRelay ? 'relay' : 'all',
    })
    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) gathered.push(candidateFromEvent(event.candidate, 'browser-probe'))
    })
    pc.addEventListener('icecandidateerror', (event) => {
      errors.push({ errorCode: event.errorCode, errorText: event.errorText })
    })
    pc.createDataChannel('endpoint-probe')
    await pc.setLocalDescription(await pc.createOffer())
    const gathering = await waitForIceGathering(pc, timeoutMs)
    const expected = gathered.filter((candidate) => wantsRelay ? candidate.type === 'relay' : candidate.type === 'srflx')
    const lastError = errors.at(-1)
    return {
      id: endpoint.id,
      url: endpoint.url,
      status: expected.length > 0 ? 'passed' : (lastError ? 'failed' : 'inconclusive'),
      elapsedMs: Math.round(performance.now() - started),
      timedOut: gathering.timedOut,
      candidateCount: gathered.length,
      candidateTypes: [...new Set(expected.map((candidate) => candidate.type))],
      protocols: [...new Set(expected.map((candidate) => candidate.protocol).filter(Boolean))],
      relayProtocols: [...new Set(expected.map((candidate) => candidate.relayProtocol).filter(Boolean))],
      error: lastError ? `${lastError.errorCode}: ${lastError.errorText}` : null,
    }
  } catch (error) {
    return {
      id: endpoint.id,
      url: endpoint.url,
      status: 'failed',
      elapsedMs: Math.round(performance.now() - started),
      timedOut: false,
      candidateCount: gathered.length,
      candidateTypes: [],
      protocols: [],
      relayProtocols: [],
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    pc?.close()
  }
}

async function checkEndpoints(endpoints, onUpdate) {
  const results = []
  await Promise.all(endpoints.map(async (endpoint) => {
    const result = await checkEndpoint(endpoint)
    results.push(result)
    onUpdate([...results])
  }))
  return results.sort((left, right) => left.id.localeCompare(right.id))
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
    foundation: candidate.foundation,
    component: candidate.component,
    priority: candidate.priority,
    type: candidate.type,
    protocol: candidate.protocol,
    address: candidate.address,
    port: candidate.port,
    relatedAddress: candidate.relatedAddress,
    relatedPort: candidate.relatedPort,
    relayProtocol: candidate.relayProtocol,
    tcpType: candidate.tcpType,
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

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ''))]
}

function classifyAddress(address) {
  const normalized = String(address ?? '').replace(/^\[|\]$/g, '').toLowerCase()
  if (!normalized) return { family: null, scope: 'hidden' }
  if (normalized.endsWith('.local')) return { family: 'mDNS', scope: 'masked' }
  if (normalized.includes(':')) {
    if (normalized === '::' || normalized === '::1') return { family: 'IPv6', scope: normalized === '::1' ? 'loopback' : 'unspecified' }
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return { family: 'IPv6', scope: 'link-local' }
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return { family: 'IPv6', scope: 'private' }
    return { family: 'IPv6', scope: 'public' }
  }
  const octets = normalized.split('.').map(Number)
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return { family: null, scope: 'hostname' }
  const [a, b] = octets
  if (a === 0) return { family: 'IPv4', scope: 'unspecified' }
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return { family: 'IPv4', scope: 'private' }
  if (a === 100 && b >= 64 && b <= 127) return { family: 'IPv4', scope: 'carrier-grade NAT' }
  if (a === 127) return { family: 'IPv4', scope: 'loopback' }
  if (a === 169 && b === 254) return { family: 'IPv4', scope: 'link-local' }
  return { family: 'IPv4', scope: 'public' }
}

function formatCandidate(candidate) {
  if (!candidate?.address) return 'hidden'
  const address = candidate.address.includes(':') ? `[${candidate.address}]` : candidate.address
  return candidate.port ? `${address}:${candidate.port}` : address
}

function formatCandidateList(candidates) {
  const values = unique(candidates.map(formatCandidate).filter((value) => value !== 'hidden'))
  return values.length > 0 ? values.join(', ') : null
}

function candidateCountText(candidates) {
  const order = ['host', 'srflx', 'prflx', 'relay']
  const counts = new Map()
  for (const candidate of candidates) counts.set(candidate.type ?? 'unknown', (counts.get(candidate.type ?? 'unknown') ?? 0) + 1)
  return [...order, ...[...counts.keys()].filter((type) => !order.includes(type))]
    .filter((type) => counts.has(type))
    .map((type) => `${counts.get(type)} ${type}`)
    .join(' · ') || 'None'
}

function peerTopology(candidates, peer) {
  const gathered = candidates.filter((candidate) => candidate.peer === peer)
  const host = gathered.filter((candidate) => candidate.type === 'host')
  const mapped = gathered.filter((candidate) => ['srflx', 'prflx'].includes(candidate.type))
  const relay = gathered.filter((candidate) => candidate.type === 'relay')
  const internal = host.filter((candidate) => ['private', 'carrier-grade NAT', 'link-local'].includes(classifyAddress(candidate.address).scope))
  const publicHost = host.filter((candidate) => classifyAddress(candidate.address).scope === 'public')
  const maskedCount = host.filter((candidate) => ['masked', 'hidden'].includes(classifyAddress(candidate.address).scope)).length
  const publicMappings = mapped.filter((candidate) => classifyAddress(candidate.address).scope === 'public')
  const directCandidates = [...host, ...mapped]
  const families = unique(directCandidates.map((candidate) => classifyAddress(candidate.address).family).filter((family) => ['IPv4', 'IPv6'].includes(family)))
  const mappingsWithPorts = mapped.filter((candidate) => Number.isInteger(candidate.relatedPort) && Number.isInteger(candidate.port))
  let portBehavior = 'Not exposed by the browser'
  if (mappingsWithPorts.length > 0) {
    const preserved = mappingsWithPorts.filter((candidate) => candidate.relatedPort === candidate.port).length
    if (preserved === mappingsWithPorts.length) portBehavior = `Preserved on ${preserved}/${mappingsWithPorts.length} observed mapping${mappingsWithPorts.length === 1 ? '' : 's'}`
    else if (preserved === 0) portBehavior = `Translated on ${mappingsWithPorts.length}/${mappingsWithPorts.length} observed mappings`
    else portBehavior = `Mixed; preserved on ${preserved}/${mappingsWithPorts.length} mappings`
  }
  const internalText = formatCandidateList([...internal, ...publicHost]) ?? (maskedCount > 0 ? `Hidden by mDNS (${maskedCount} candidate${maskedCount === 1 ? '' : 's'})` : 'Not observed')
  return {
    gathered,
    internal,
    maskedCount,
    publicMappings,
    relay,
    families,
    mappingsWithPorts,
    portBehavior,
    rows: [
      ['Internal / host', internalText],
      ['Public mapping', formatCandidateList(publicMappings) ?? 'Not observed'],
      ['Address families', families.join(' + ') || 'Not observed'],
      ['NAT port mapping', portBehavior],
      ['Candidates', candidateCountText(gathered)],
      ['TURN fallback', relay.length > 0 ? `${relay.length} relay candidate${relay.length === 1 ? '' : 's'}` : 'None gathered'],
    ],
  }
}

function browserEnvironment() {
  const connection = navigator.connection ?? navigator.mozConnection ?? navigator.webkitConnection
  const navigation = performance.getEntriesByType('navigation')[0]
  return {
    online: navigator.onLine,
    effectiveType: connection?.effectiveType ?? null,
    downlinkMbps: connection?.downlink ?? null,
    reportedRttMs: connection?.rtt ?? null,
    saveData: connection?.saveData ?? null,
    httpProtocol: navigation?.nextHopProtocol || null,
    secureContext: window.isSecureContext,
  }
}

function analyzeNetwork({ candidates, pair, endpoints, endpointChecks, timings, environment }) {
  const browser = peerTopology(candidates, 'browser')
  const cluster = peerTopology(candidates, 'cluster')
  const pairTypes = [pair?.local?.type, pair?.remote?.type]
  const relayed = pairTypes.includes('relay')
  const natTraversed = !relayed && pairTypes.some((type) => ['srflx', 'prflx'].includes(type))
  const route = relayed ? 'TURN relay' : (natTraversed ? 'Direct NAT traversal' : 'Direct host path')
  const selectedFamilies = unique([pair?.local, pair?.remote].map((candidate) => classifyAddress(candidate?.address).family).filter(Boolean))
  const selectedTransport = unique([pair?.local?.protocol, pair?.remote?.protocol].filter(Boolean)).join(' / ') || 'Not reported'
  const findings = []
  findings.push({
    kind: relayed ? 'info' : 'good',
    title: relayed ? 'TURN carried the connection' : 'Direct connectivity succeeded',
    detail: relayed
      ? 'The nominated path uses a relay, so direct ICE connectivity was not selected for this run.'
      : `${route} established a working data channel over ${selectedTransport}.`,
  })

  const browserEdge = pair?.local
  const clusterEdge = pair?.remote
  if (classifyAddress(browserEdge?.address).scope === 'public' && classifyAddress(clusterEdge?.address).scope === 'public' && browserEdge.address !== clusterEdge.address) {
    findings.push({ kind: 'info', title: 'Two distinct public network edges', detail: `The browser appeared as ${formatCandidate(browserEdge)} and the cluster as ${formatCandidate(clusterEdge)}.` })
  }
  if (browser.maskedCount > 0) {
    findings.push({ kind: 'info', title: 'Browser LAN address protected', detail: `${browser.maskedCount} host candidate${browser.maskedCount === 1 ? ' was' : 's were'} represented by mDNS, so the private subnet cannot be determined.` })
  }
  if (cluster.internal.length > 0) {
    findings.push({ kind: 'warn', title: 'Cluster internal address exposed', detail: `The peer advertised ${formatCandidateList(cluster.internal)}; this is likely pod or node network topology and should be redacted from shared reports.` })
  }

  for (const [label, topology] of [['Browser', browser], ['Cluster', cluster]]) {
    if (topology.mappingsWithPorts.length === 0) continue
    const preserved = topology.mappingsWithPorts.filter((candidate) => candidate.relatedPort === candidate.port).length
    findings.push({
      kind: preserved === topology.mappingsWithPorts.length ? 'good' : 'info',
      title: `${label} NAT port behavior`,
      detail: `${topology.portBehavior}. This describes the observed STUN mappings but does not identify the NAT's cone/symmetric filtering type.`,
    })
  }

  const directFamilies = unique([...browser.families, ...cluster.families])
  if (!directFamilies.includes('IPv6')) {
    findings.push({ kind: 'warn', title: 'No usable IPv6 path observed', detail: 'Host and server-reflexive candidates were IPv4-only, so this run did not demonstrate native IPv6 connectivity.' })
  } else if (!browser.families.includes('IPv6') || !cluster.families.includes('IPv6')) {
    const capablePeer = browser.families.includes('IPv6') ? 'browser' : 'cluster'
    findings.push({ kind: 'warn', title: 'IPv6 available on only one peer', detail: `The ${capablePeer} exposed IPv6 candidates, but the other peer did not; a native end-to-end IPv6 path was not demonstrated.` })
  } else {
    findings.push({ kind: 'good', title: 'Both peers exposed IPv6', detail: 'Browser and cluster each gathered an IPv6 host or server-reflexive candidate, although the nominated pair remains authoritative for actual use.' })
  }

  const endpointByID = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]))
  const turnChecks = endpointChecks.filter((check) => endpointByID.get(check.id)?.type.startsWith('TURN'))
  const passedTurn = turnChecks.filter((check) => check.status === 'passed')
  const failedTurn = turnChecks.filter((check) => check.status !== 'passed')
  if (turnChecks.length > 0) {
    const controls = unique(passedTurn.flatMap((check) => check.relayProtocols)).map((value) => value.toUpperCase())
    findings.push({
      kind: failedTurn.length === 0 ? 'good' : (passedTurn.length > 0 ? 'warn' : 'bad'),
      title: `TURN reachability ${passedTurn.length}/${turnChecks.length}`,
      detail: failedTurn.length === 0
        ? `Every configured TURN endpoint produced a relay candidate${controls.length > 0 ? `; observed control transports: ${controls.join(', ')}` : ''}.`
        : `${failedTurn.length} endpoint${failedTurn.length === 1 ? '' : 's'} did not produce a relay candidate; inspect the endpoint table for blocked ports or transports.`,
    })
  }
  if (timings.browserGathering?.timedOut || timings.serverGathering?.timedOut) {
    const peers = [timings.browserGathering?.timedOut ? 'browser' : null, timings.serverGathering?.timedOut ? 'cluster' : null].filter(Boolean)
    findings.push({ kind: 'warn', title: 'ICE gathering reached its deadline', detail: `${peers.join(' and ')} gathering stopped at the diagnostic timeout; candidates may be incomplete even without an explicit ICE error.` })
  }

  const environmentRows = []
  if (environment.effectiveType) environmentRows.push(['Browser network estimate', `${environment.effectiveType}${environment.downlinkMbps == null ? '' : ` · ${environment.downlinkMbps} Mbps`}${environment.reportedRttMs == null ? '' : ` · ${environment.reportedRttMs} ms RTT`}`])
  if (environment.httpProtocol) environmentRows.push(['Page transport', environment.httpProtocol])

  return {
    browser,
    cluster,
    findings,
    pathRows: [
      ['Route', route],
      ['Transport', selectedTransport],
      ['Browser edge', formatCandidate(pair?.local)],
      ['Cluster edge', formatCandidate(pair?.remote)],
      ['Address family', selectedFamilies.join(' / ') || 'Not reported'],
      ['Round trip', pair?.rttMs == null ? 'Not reported' : `${pair.rttMs} ms`],
    ],
    environmentRows,
    evidence: {
      route,
      selectedFamilies,
      browser: { families: browser.families, portBehavior: browser.portBehavior, maskedHostCandidates: browser.maskedCount },
      cluster: { families: cluster.families, portBehavior: cluster.portBehavior, internalAddresses: cluster.internal.map(formatCandidate) },
      endpointReachability: { passed: endpointChecks.filter((check) => check.status === 'passed').length, total: endpointChecks.length },
    },
  }
}

function renderAnalysis(analysis) {
  rows(ui.browserTopology, analysis.browser.rows)
  rows(ui.pathTopology, analysis.pathRows)
  rows(ui.clusterTopology, analysis.cluster.rows)
  ui.findings.replaceChildren()
  for (const finding of analysis.findings) {
    const item = document.createElement('li')
    item.className = `finding ${finding.kind}`
    const title = document.createElement('strong')
    const detail = document.createElement('span')
    title.textContent = finding.title
    detail.textContent = finding.detail
    item.append(title, detail)
    ui.findings.append(item)
  }
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
  const startedPerf = performance.now()
  const candidates = []
  const iceErrors = []
  const environment = browserEnvironment()
  const timings = {}
  let endpoints = []
  let endpointChecks = []
  let endpointChecksPromise = Promise.resolve([])
  setStatus('pending', policy === 'relay' ? 'Testing forced TURN…' : 'Testing automatic ICE path…', 'Gathering candidates from both peers.')
  rows(ui.pair, [['Status', 'Negotiating']])
  rows(ui.test, [['Mode', policy === 'relay' ? 'Relay only' : 'Automatic fallback'], ['Started', startedAt.toLocaleTimeString()]])
  rows(ui.browserTopology, [['Status', 'Gathering candidates']])
  rows(ui.pathTopology, [['Status', 'Negotiating']])
  rows(ui.clusterTopology, [['Status', 'Waiting for offer']])
  ui.findings.replaceChildren()
  const runningFinding = document.createElement('li')
  runningFinding.className = 'finding neutral'
  const runningTitle = document.createElement('strong')
  const runningDetail = document.createElement('span')
  runningTitle.textContent = 'Diagnostic running'
  runningDetail.textContent = 'Testing the selected path and each configured ICE endpoint.'
  runningFinding.append(runningTitle, runningDetail)
  ui.findings.append(runningFinding)
  renderEndpoints(endpoints, iceErrors)
  renderCandidates(candidates)

  let pc
  try {
    const configStarted = performance.now()
    const configResponse = await fetch('/api/config', { cache: 'no-store' })
    timings.configMs = Math.round(performance.now() - configStarted)
    if (!configResponse.ok) throw new Error(`ICE configuration failed: HTTP ${configResponse.status}`)
    const config = await configResponse.json()
    endpoints = configuredEndpoints(config.iceServers)
    renderEndpoints(endpoints, iceErrors)
    endpointChecksPromise = checkEndpoints(endpoints, (checks) => {
      endpointChecks = checks
      renderEndpoints(endpoints, iceErrors, endpointChecks)
    })
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
      renderEndpoints(endpoints, iceErrors, endpointChecks)
    })
    pc.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return
      candidates.push(candidateFromEvent(event.candidate, 'browser'))
      renderCandidates(candidates)
    })
    const channel = pc.createDataChannel('path-diagnostic', { ordered: true })
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    timings.browserGathering = await waitForIceGathering(pc)

    const signalingStarted = performance.now()
    const offerResponse = await fetch('/api/offer', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }),
    })
    const answerBody = await offerResponse.json()
    timings.signalingMs = Math.round(performance.now() - signalingStarted)
    if (!offerResponse.ok) throw new Error(answerBody.error ?? `Offer failed: HTTP ${offerResponse.status}`)
    timings.serverGathering = answerBody.serverGathering ?? null
    active.sessionId = answerBody.sessionId
    for (const candidate of answerBody.serverCandidates ?? []) {
      try { candidates.push(candidateFromSdp(candidate, 'cluster')) } catch { /* retain the connection even if a browser cannot parse one server candidate */ }
    }
    renderCandidates(candidates)
    const connectionStarted = performance.now()
    await pc.setRemoteDescription(answerBody.answer)
    await waitForOpen(channel, pc)
    timings.connectionMs = Math.round(performance.now() - connectionStarted)
    const echoRttMs = await ping(channel)
    await new Promise((resolve) => window.setTimeout(resolve, 200))
    const pair = await selectedPair(pc)
    if (!pair) throw new Error('Connected, but the browser did not expose a selected ICE candidate pair')
    endpointChecks = await endpointChecksPromise
    renderEndpoints(endpoints, iceErrors, endpointChecks)
    timings.totalMs = Math.round(performance.now() - startedPerf)
    const result = verdict(pair)
    const analysis = analyzeNetwork({ candidates, pair, endpoints, endpointChecks, timings, environment })
    setStatus(result.kind, result.label, result.detail)
    renderAnalysis(analysis)
    rows(ui.pair, [
      ['Local', `${pair.local?.type ?? 'unknown'} · ${pair.local?.protocol ?? '—'} · ${formatCandidate(pair.local)}`],
      ['Remote', `${pair.remote?.type ?? 'unknown'} · ${pair.remote?.protocol ?? '—'} · ${formatCandidate(pair.remote)}`],
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
      ['Endpoint checks', `${endpointChecks.filter((check) => check.status === 'passed').length}/${endpointChecks.length} produced expected candidates`],
      ['Candidates', String(candidates.length)],
      ['ICE server errors', String(iceErrors.length)],
      ['Browser gathering', `${timings.browserGathering.elapsedMs} ms${timings.browserGathering.timedOut ? ' · timed out' : ''}`],
      ['Cluster gathering', timings.serverGathering ? `${timings.serverGathering.durationMs} ms${timings.serverGathering.timedOut ? ' · timed out' : ''}` : 'Not reported'],
      ['Connection setup', `${timings.connectionMs} ms`],
      ['Total diagnostic', `${timings.totalMs} ms`],
      ...analysis.environmentRows,
      ['Completed', new Date().toLocaleTimeString()],
    ])
    lastReport = {
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      policy,
      config: { turnConfigured: config.turnConfigured, warning: config.warning, endpoints },
      verdict: result,
      topology: analysis.evidence,
      findings: analysis.findings,
      environment,
      timings,
      pair,
      echoRttMs,
      candidates,
      endpointChecks,
      iceErrors,
    }
    ui.copy.disabled = false
  } catch (error) {
    endpointChecks = await endpointChecksPromise.catch(() => endpointChecks)
    renderEndpoints(endpoints, iceErrors, endpointChecks)
    timings.totalMs = Math.round(performance.now() - startedPerf)
    const browser = peerTopology(candidates, 'browser')
    const cluster = peerTopology(candidates, 'cluster')
    setStatus('failed', 'Diagnostic failed', error instanceof Error ? error.message : String(error))
    rows(ui.pair, [['Status', 'No nominated pair']])
    rows(ui.browserTopology, browser.rows)
    rows(ui.pathTopology, [['Status', 'No working path selected']])
    rows(ui.clusterTopology, cluster.rows)
    ui.findings.replaceChildren()
    const failedFinding = document.createElement('li')
    failedFinding.className = 'finding bad'
    const failedTitle = document.createElement('strong')
    const failedDetail = document.createElement('span')
    failedTitle.textContent = 'End-to-end path failed'
    failedDetail.textContent = error instanceof Error ? error.message : String(error)
    failedFinding.append(failedTitle, failedDetail)
    ui.findings.append(failedFinding)
    rows(ui.test, [
      ['Mode', policy === 'relay' ? 'Relay only' : 'Automatic fallback'],
      ['Error', error instanceof Error ? error.message : String(error)],
      ['Endpoint checks', `${endpointChecks.filter((check) => check.status === 'passed').length}/${endpointChecks.length} passed`],
      ['Total diagnostic', `${timings.totalMs} ms`],
    ])
    lastReport = {
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      policy,
      error: error instanceof Error ? error.message : String(error),
      environment,
      timings,
      endpoints,
      candidates,
      endpointChecks,
      iceErrors,
    }
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
