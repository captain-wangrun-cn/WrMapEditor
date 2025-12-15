import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type Prefab = {
  id: string
  name: string
  color: string
  emoji?: string
  defaultWidth: number
  defaultHeight: number
}

type Entity = {
  id: string
  prefabId: string
  name?: string
  x: number
  y: number
  scale: number
  rotation: number
  width: number
  height: number
}

type Project = {
  name: string
  width: number
  height: number
  background: string
  snapSize: number
  prefabs: Prefab[]
  entities: Entity[]
  lastUpdatedAt: number
  lastUpdatedBy?: string
}

type Camera = {
  x: number
  y: number
  zoom: number
}

const DEFAULT_PREFABS: Prefab[] = [
  { id: 'ground', name: '地面平台', color: '#8B5A2B', emoji: '🧱', defaultWidth: 192, defaultHeight: 48 },
  { id: 'grass', name: '草皮', color: '#4CAF50', emoji: '🌿', defaultWidth: 160, defaultHeight: 36 },
  { id: 'stone', name: '石块', color: '#9E9E9E', emoji: '🪨', defaultWidth: 96, defaultHeight: 96 },
  { id: 'spike', name: '地刺', color: '#EF5350', emoji: '⚠️', defaultWidth: 96, defaultHeight: 28 },
  { id: 'coin', name: '金币', color: '#FBC02D', emoji: '🪙', defaultWidth: 32, defaultHeight: 32 },
  { id: 'spawn', name: '出生点', color: '#2196F3', emoji: '🚩', defaultWidth: 48, defaultHeight: 72 },
]

const STORAGE_KEY = 'wrmapeditor:lastProject-v2'

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const snapValue = (value: number, snap: number) => (snap > 0 ? Math.round(value / snap) * snap : value)

const createProject = (name: string, width: number, height: number): Project => ({
  name,
  width,
  height,
  background: '#0b1220',
  snapSize: 32,
  prefabs: DEFAULT_PREFABS,
  entities: [],
  lastUpdatedAt: Date.now(),
  lastUpdatedBy: 'local',
})

function App() {
  const APP_VERSION = 'v0.1.0'

  const savedProject = useMemo(() => {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Project
      if (!parsed.entities || !parsed.prefabs) return null
      return parsed
    } catch (err) {
      console.warn('Failed to parse saved project', err)
      return null
    }
  }, [])

  const [project, setProject] = useState<Project>(savedProject ?? createProject('横版关卡', 4096, 1536))
  const [selectedPrefabId, setSelectedPrefabId] = useState<string>(project.prefabs[0].id)
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null)
  const [tool, setTool] = useState<'place' | 'select' | 'pan'>('place')
  const [camera, setCamera] = useState<Camera>({ x: 100, y: 80, zoom: 1 })
  const [hoverPoint, setHoverPoint] = useState<{ x: number; y: number } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragMode, setDragMode] = useState<'pan' | 'move-entity' | 'place' | null>(null)
  const dragStateRef = useRef<{ isDragging: boolean; dragMode: 'pan' | 'move-entity' | 'place' | null }>({
    isDragging: false,
    dragMode: null,
  })
  const [lastPoint, setLastPoint] = useState<{ x: number; y: number } | null>(null)
  const [canvasSize, setCanvasSize] = useState({ width: 900, height: 600 })
  const [newProjectForm, setNewProjectForm] = useState({
    name: project.name,
    width: project.width,
    height: project.height,
  })
  const [customPrefabForm, setCustomPrefabForm] = useState({
    name: '',
    color: '#f59e0b',
    emoji: '',
    width: 120,
    height: 60,
  })
  const [placementSettings, setPlacementSettings] = useState({
    width: 0,
    height: 0,
    scale: 1,
    rotation: 0,
    snapEnabled: true,
  })

  const [wsUrl, setWsUrl] = useState('ws://localhost:8765')
  const [sessionId, setSessionId] = useState('room-1')
  const [wsStatus, setWsStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected')
  const wsRef = useRef<WebSocket | null>(null)
  const [clientId] = useState(() => `client-${Math.random().toString(16).slice(2, 8)}`)
  const applyingRemoteRef = useRef(false)

  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchStartDistance = useRef<number | null>(null)
  const pinchStartZoom = useRef<number>(1)
  useEffect(() => {
    const update = () => {
      if (!surfaceRef.current) return
      const { clientWidth, clientHeight } = surfaceRef.current
      setCanvasSize({ width: clientWidth, height: clientHeight })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project))
  }, [project])

  const screenToWorld = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const x = (clientX - rect.left - camera.x) / camera.zoom
    const y = (clientY - rect.top - camera.y) / camera.zoom
    return { x, y }
  }

  const stampProject = (p: Project): Project => ({
    ...p,
    lastUpdatedAt: Date.now(),
    lastUpdatedBy: clientId,
  })

  const ensureProjectDefaults = (p: Project): Project => ({
    ...p,
    lastUpdatedAt: p.lastUpdatedAt ?? Date.now(),
    lastUpdatedBy: p.lastUpdatedBy ?? 'remote',
  })

  const hitTestEntity = (x: number, y: number) => {
    // simple AABB hit test (ignores rotation for simplicity)
    for (let i = project.entities.length - 1; i >= 0; i -= 1) {
      const e = project.entities[i]
      const w = e.width * e.scale
      const h = e.height * e.scale
      if (x >= e.x - w / 2 && x <= e.x + w / 2 && y >= e.y - h / 2 && y <= e.y + h / 2) {
        return e
      }
    }
    return null
  }

  const currentPrefab = project.prefabs.find((p) => p.id === selectedPrefabId)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = canvasSize.width * dpr
    canvas.height = canvasSize.height * dpr
    canvas.style.width = `${canvasSize.width}px`
    canvas.style.height = `${canvasSize.height}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    ctx.fillStyle = project.background
    ctx.fillRect(0, 0, canvasSize.width, canvasSize.height)

    ctx.save()
    ctx.translate(camera.x, camera.y)
    ctx.scale(camera.zoom, camera.zoom)

    // stage border
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.lineWidth = 2 / camera.zoom
    ctx.strokeRect(0, 0, project.width, project.height)

    // grid
    const step = project.snapSize || 64
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1 / camera.zoom
    for (let x = 0; x <= project.width; x += step) {
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, project.height)
      ctx.stroke()
    }
    for (let y = 0; y <= project.height; y += step) {
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(project.width, y)
      ctx.stroke()
    }

    // entities
    project.entities.forEach((entity) => {
      const prefab = project.prefabs.find((p) => p.id === entity.prefabId)
      const w = entity.width * entity.scale
      const h = entity.height * entity.scale
      ctx.save()
      ctx.translate(entity.x, entity.y)
      ctx.rotate((entity.rotation * Math.PI) / 180)
      ctx.fillStyle = prefab?.color ?? '#94a3b8'
      ctx.fillRect(-w / 2, -h / 2, w, h)
      if (prefab?.emoji) {
        ctx.fillStyle = '#0b1220'
        ctx.font = `${Math.max(12, Math.floor(Math.min(w, h) * 0.5))}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(prefab.emoji, 0, 0)
      }
      if (entity.id === selectedEntityId) {
        ctx.strokeStyle = '#60a5fa'
        ctx.lineWidth = 3 / camera.zoom
        ctx.strokeRect(-w / 2, -h / 2, w, h)
      }
      ctx.restore()
    })

    // hover crosshair
    if (hoverPoint) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.lineWidth = 1 / camera.zoom
      ctx.beginPath()
      ctx.moveTo(hoverPoint.x - 12, hoverPoint.y)
      ctx.lineTo(hoverPoint.x + 12, hoverPoint.y)
      ctx.moveTo(hoverPoint.x, hoverPoint.y - 12)
      ctx.lineTo(hoverPoint.x, hoverPoint.y + 12)
      ctx.stroke()
    }

    ctx.restore()
  }, [project, camera, canvasSize, selectedEntityId, hoverPoint])

  const placeEntity = (world: { x: number; y: number }) => {
    if (!currentPrefab) return
    const width = placementSettings.width > 0 ? placementSettings.width : currentPrefab.defaultWidth
    const height = placementSettings.height > 0 ? placementSettings.height : currentPrefab.defaultHeight
    const snap = placementSettings.snapEnabled ? project.snapSize : 0
    const snappedX = snapValue(world.x, snap)
    const snappedY = snapValue(world.y, snap)
    const entity: Entity = {
      id: `ent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      prefabId: currentPrefab.id,
      name: currentPrefab.name,
      x: snappedX,
      y: snappedY,
      scale: placementSettings.scale,
      rotation: placementSettings.rotation,
      width,
      height,
    }
    setProject((prev) => stampProject({ ...prev, entities: [...prev.entities, entity] }))
    setSelectedEntityId(entity.id)
  }

  const handlePointerDown: React.PointerEventHandler<HTMLCanvasElement> = (e) => {
    e.preventDefault()
    const point = { x: e.clientX, y: e.clientY }
    pointersRef.current.set(e.pointerId, point)

    if (pointersRef.current.size === 2) {
      const [a, b] = Array.from(pointersRef.current.values())
      pinchStartDistance.current = Math.hypot(a.x - b.x, a.y - b.y)
      pinchStartZoom.current = camera.zoom
      setDragMode('pan')
      setIsDragging(true)
      setLastPoint({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
      return
    }

    const world = screenToWorld(point.x, point.y)
    if (!world) return
    setHoverPoint(world)

    const targetEntity = hitTestEntity(world.x, world.y)

    if (tool === 'pan' || e.button === 1 || e.button === 2) {
      setDragMode('pan')
    } else if (tool === 'select' && targetEntity) {
      setSelectedEntityId(targetEntity.id)
      setDragMode('move-entity')
    } else if (tool === 'place') {
      placeEntity(world)
      setDragMode('place')
    } else if (targetEntity) {
      setSelectedEntityId(targetEntity.id)
      setDragMode('move-entity')
    }

    setIsDragging(true)
    dragStateRef.current = { isDragging: true, dragMode: dragMode ?? 'place' }
  setLastPoint(point)
  }

  const handlePointerMove: React.PointerEventHandler<HTMLCanvasElement> = (e) => {
    const point = { x: e.clientX, y: e.clientY }
    pointersRef.current.set(e.pointerId, point)

    if (pointersRef.current.size >= 2) {
      const values = Array.from(pointersRef.current.values())
      const [a, b] = values
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      if (pinchStartDistance.current) {
        const scale = distance / pinchStartDistance.current
        setCamera((prev) => ({ ...prev, zoom: clamp(pinchStartZoom.current * scale, 0.3, 3.5) }))
      }
      if (lastPoint) {
        setCamera((prev) => ({ ...prev, x: prev.x + (center.x - lastPoint.x), y: prev.y + (center.y - lastPoint.y) }))
      }
      setLastPoint(center)
      return
    }

    const world = screenToWorld(point.x, point.y)
    if (world) setHoverPoint(world)

    if (!isDragging || !dragMode) return

    if (dragMode === 'pan' && lastPoint) {
      const dx = point.x - lastPoint.x
      const dy = point.y - lastPoint.y
      setCamera((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }))
      setLastPoint(point)
      return
    }

    if (dragMode === 'move-entity' && selectedEntityId && world && lastPoint) {
      const dx = (point.x - lastPoint.x) / camera.zoom
      const dy = (point.y - lastPoint.y) / camera.zoom
      setProject((prev) => stampProject({
        ...prev,
        entities: prev.entities.map((ent) =>
          ent.id === selectedEntityId
            ? { ...ent, x: ent.x + dx, y: ent.y + dy }
            : ent,
        ),
      }))
      setLastPoint(point)
    }
  }

  const handlePointerUp: React.PointerEventHandler<HTMLCanvasElement> = (e) => {
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) {
      pinchStartDistance.current = null
    }
    setIsDragging(false)
    dragStateRef.current = { isDragging: false, dragMode: null }
    setDragMode(null)
    setLastPoint(null)
  }

  const handleWheel: React.WheelEventHandler<HTMLCanvasElement> = (e) => {
    e.preventDefault()
    const direction = e.deltaY > 0 ? -0.12 : 0.12
    setCamera((prev) => ({ ...prev, zoom: clamp(prev.zoom + direction, 0.3, 3.5) }))
  }

  const handleNewProject = () => {
    const w = clamp(Number(newProjectForm.width) || 512, 256, 10000)
    const h = clamp(Number(newProjectForm.height) || 512, 256, 6000)
    const project = createProject(newProjectForm.name || '新关卡', w, h)
    setProject(stampProject(project))
    setSelectedPrefabId(project.prefabs[0].id)
    setSelectedEntityId(null)
    setCamera({ x: 100, y: 80, zoom: 1 })
  }

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${project.name || 'map'}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImport = async (file: File) => {
    const text = await file.text()
    const parsed = JSON.parse(text) as Project
    if (!parsed.entities || !parsed.prefabs) throw new Error('无效的项目文件')
    setProject(ensureProjectDefaults(parsed))
    setSelectedPrefabId(parsed.prefabs[0]?.id ?? DEFAULT_PREFABS[0].id)
    setSelectedEntityId(null)
    setCamera({ x: 100, y: 80, zoom: 1 })
  }

  const handleFileChange: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      await handleImport(file)
    } catch (err) {
      alert(`导入失败: ${(err as Error).message}`)
    }
  }

  const handleAddPrefab = () => {
    const name = customPrefabForm.name.trim() || `Prefab ${project.prefabs.length + 1}`
    const id = `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`
    const newPrefab: Prefab = {
      id,
      name,
      color: customPrefabForm.color,
      emoji: customPrefabForm.emoji || undefined,
      defaultWidth: Math.max(16, customPrefabForm.width),
      defaultHeight: Math.max(16, customPrefabForm.height),
    }
    setProject((prev) => stampProject({ ...prev, prefabs: [...prev.prefabs, newPrefab] }))
    setSelectedPrefabId(id)
    setCustomPrefabForm({ name: '', color: '#f59e0b', emoji: '', width: 120, height: 60 })
  }

  const handleClear = () => {
    if (!confirm('确定要清空当前场景吗？')) return
    setProject((prev) => stampProject({ ...prev, entities: [] }))
    setSelectedEntityId(null)
  }

  const handleCenter = () => {
    const stageW = project.width * camera.zoom
    const stageH = project.height * camera.zoom
    const nextX = (canvasSize.width - stageW) / 2
    const nextY = (canvasSize.height - stageH) / 2
    setCamera((prev) => ({ ...prev, x: nextX, y: nextY }))
  }

  const selectedEntity = project.entities.find((e) => e.id === selectedEntityId)

  const updateSelectedEntity = (partial: Partial<Entity>) => {
    if (!selectedEntity) return
    setProject((prev) => stampProject({
      ...prev,
      entities: prev.entities.map((e) => (e.id === selectedEntity.id ? { ...e, ...partial } : e)),
    }))
  }

  const disconnectWs = () => {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    setWsStatus('disconnected')
  }

  const connectWs = () => {
    if (wsStatus === 'connecting' || wsStatus === 'connected') return
    try {
      const socket = new WebSocket(wsUrl)
      wsRef.current = socket
      setWsStatus('connecting')

      socket.onopen = () => {
        setWsStatus('connected')
        socket.send(JSON.stringify({ type: 'join', sessionId, clientId }))
        socket.send(JSON.stringify({ type: 'project_snapshot', sessionId, clientId, project }))
      }

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'project_snapshot' && msg.sessionId === sessionId && msg.project) {
            const { isDragging: draggingNow, dragMode: draggingMode } = dragStateRef.current
            if (draggingNow && draggingMode === 'move-entity') return
            const incoming = ensureProjectDefaults(msg.project as Project)
            applyingRemoteRef.current = true
            setProject({ ...incoming })
          }
        } catch (err) {
          console.warn('WS parse error', err)
        }
      }

      socket.onclose = () => {
        setWsStatus('disconnected')
        if (wsRef.current === socket) wsRef.current = null
      }

      socket.onerror = () => {
        setWsStatus('disconnected')
      }
    } catch (err) {
      console.error('WS connect failed', err)
      setWsStatus('disconnected')
    }
  }

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (wsStatus !== 'connected') return
    if (applyingRemoteRef.current) {
      applyingRemoteRef.current = false
      return
    }
    const socket = wsRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    const payload = { type: 'update_project', sessionId, clientId, project }
    socket.send(JSON.stringify(payload))
  }, [project, wsStatus, sessionId, clientId])

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="project-info">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 18 }}>横版地图编辑器</strong>
            <span className="pill">{APP_VERSION}</span>
          </div>
          <input
            className="project-name"
            value={project.name}
            onChange={(e) => setProject((prev) => stampProject({ ...prev, name: e.target.value }))}
            placeholder="项目名称"
          />
          <div className="pill">{Math.round(project.width)} × {Math.round(project.height)} px</div>
        </div>
        <div className="toolbar">
          <button className="ghost" onClick={handleCenter}>居中</button>
          <button className={tool === 'place' ? 'primary' : 'ghost'} onClick={() => setTool('place')}>放置</button>
          <button className={tool === 'select' ? 'primary' : 'ghost'} onClick={() => setTool('select')}>选择/移动</button>
          <button className={tool === 'pan' ? 'primary' : 'ghost'} onClick={() => setTool('pan')}>平移</button>
          <button onClick={handleClear}>清空实体</button>
          <button onClick={handleExport}>导出JSON</button>
          <button onClick={() => fileInputRef.current?.click()}>导入JSON</button>
          <input ref={fileInputRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={handleFileChange} />
        </div>
      </header>

      <main className="layout">
        <aside className="sidebar">
          <div className="sidebar-scroll">
            <section className="panel">
              <div className="panel-title">新建/舞台尺寸</div>
              <div className="form-grid">
                <label>
                  名称
                  <input value={newProjectForm.name} onChange={(e) => setNewProjectForm({ ...newProjectForm, name: e.target.value })} />
                </label>
                <label>
                  宽度(px)
                  <input
                    type="number"
                    min={256}
                    max={10000}
                    value={newProjectForm.width}
                    onChange={(e) => setNewProjectForm({ ...newProjectForm, width: Number(e.target.value) })}
                  />
                </label>
                <label>
                  高度(px)
                  <input
                    type="number"
                    min={256}
                    max={6000}
                    value={newProjectForm.height}
                    onChange={(e) => setNewProjectForm({ ...newProjectForm, height: Number(e.target.value) })}
                  />
                </label>
                <label>
                  网格间距
                  <input
                    type="number"
                    min={0}
                    max={512}
                    value={project.snapSize}
                    onChange={(e) => setProject((prev) => stampProject({ ...prev, snapSize: Number(e.target.value) || 0 }))}
                  />
                </label>
                <button className="primary" onClick={handleNewProject}>新建项目</button>
              </div>
            </section>

            <section className="panel">
              <div className="panel-title">预制体</div>
              <div className="prefab-grid">
                {project.prefabs.map((prefab) => (
                  <button
                    key={prefab.id}
                    className={`prefab ${selectedPrefabId === prefab.id ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedPrefabId(prefab.id)
                      setTool('place')
                      setPlacementSettings((s) => ({ ...s, width: 0, height: 0, scale: 1, rotation: 0 }))
                    }}
                  >
                    <span className="prefab-color" style={{ background: prefab.color }} />
                    <div className="prefab-meta">
                      <div className="prefab-name">{prefab.name}</div>
                      <div className="prefab-tag">{prefab.defaultWidth}×{prefab.defaultHeight}</div>
                    </div>
                    <span className="prefab-emoji">{prefab.emoji ?? '⬜️'}</span>
                  </button>
                ))}
              </div>
              <div className="panel-title">新增预制</div>
              <div className="form-grid">
                <label>
                  名称
                  <input
                    value={customPrefabForm.name}
                    placeholder="如：木箱"
                    onChange={(e) => setCustomPrefabForm({ ...customPrefabForm, name: e.target.value })}
                  />
                </label>
                <label>
                  颜色
                  <input
                    type="color"
                    value={customPrefabForm.color}
                    onChange={(e) => setCustomPrefabForm({ ...customPrefabForm, color: e.target.value })}
                  />
                </label>
                <label>
                  图标
                  <input
                    value={customPrefabForm.emoji}
                    placeholder="可选Emoji"
                    onChange={(e) => setCustomPrefabForm({ ...customPrefabForm, emoji: e.target.value })}
                  />
                </label>
                <label>
                  宽度
                  <input
                    type="number"
                    min={16}
                    max={512}
                    value={customPrefabForm.width}
                    onChange={(e) => setCustomPrefabForm({ ...customPrefabForm, width: Number(e.target.value) })}
                  />
                </label>
                <label>
                  高度
                  <input
                    type="number"
                    min={16}
                    max={512}
                    value={customPrefabForm.height}
                    onChange={(e) => setCustomPrefabForm({ ...customPrefabForm, height: Number(e.target.value) })}
                  />
                </label>
                <button onClick={handleAddPrefab}>添加预制</button>
              </div>
            </section>

            <section className="panel">
              <div className="panel-title">放置参数</div>
              <div className="form-grid">
                <label>
                  宽度(px)
                  <input
                    type="number"
                    min={8}
                    max={1024}
                    value={placementSettings.width}
                    onChange={(e) => setPlacementSettings({ ...placementSettings, width: Number(e.target.value) })}
                  />
                </label>
                <label>
                  高度(px)
                  <input
                    type="number"
                    min={8}
                    max={1024}
                    value={placementSettings.height}
                    onChange={(e) => setPlacementSettings({ ...placementSettings, height: Number(e.target.value) })}
                  />
                </label>
                <label>
                  缩放
                  <input
                    type="number"
                    min={0.1}
                    max={5}
                    step={0.1}
                    value={placementSettings.scale}
                    onChange={(e) => setPlacementSettings({ ...placementSettings, scale: Number(e.target.value) })}
                  />
                </label>
                <label>
                  旋转(°)
                  <input
                    type="number"
                    min={-180}
                    max={180}
                    step={1}
                    value={placementSettings.rotation}
                    onChange={(e) => setPlacementSettings({ ...placementSettings, rotation: Number(e.target.value) })}
                  />
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={placementSettings.snapEnabled}
                    onChange={(e) => setPlacementSettings({ ...placementSettings, snapEnabled: e.target.checked })}
                  />
                  对齐网格
                </label>
              </div>
            </section>

            <section className="panel">
              <div className="panel-title">状态</div>
              <div className="stat-row">
                <span>当前工具</span>
                <strong>{tool === 'place' ? '放置' : tool === 'select' ? '选择/移动' : '平移'}</strong>
              </div>
              <div className="stat-row">
                <span>选中预制</span>
                <strong>{currentPrefab?.name ?? '未选择'}</strong>
              </div>
              <div className="stat-row">
                <span>缩放</span>
                <strong>{camera.zoom.toFixed(2)}x</strong>
              </div>
              {hoverPoint && (
                <div className="stat-row">
                  <span>指针坐标</span>
                  <strong>{hoverPoint.x.toFixed(0)}, {hoverPoint.y.toFixed(0)}</strong>
                </div>
              )}
              <div className="stat-row">
                <span>实体数量</span>
                <strong>{project.entities.length}</strong>
              </div>
            </section>

            <section className="panel">
              <div className="panel-title">实时协作</div>
              <div className="form-grid">
                <label>
                  WebSocket URL
                  <input
                    value={wsUrl}
                    onChange={(e) => setWsUrl(e.target.value)}
                    placeholder="ws://localhost:8765"
                  />
                </label>
                <label>
                  会话ID
                  <input
                    value={sessionId}
                    onChange={(e) => setSessionId(e.target.value)}
                    placeholder="room-1"
                  />
                </label>
                <div className="stat-row" style={{ borderBottom: 'none', padding: 0 }}>
                  <span>状态</span>
                  <strong>{wsStatus === 'connected' ? '已连接' : wsStatus === 'connecting' ? '连接中' : '未连接'}</strong>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className={wsStatus === 'connected' ? 'ghost' : 'primary'} onClick={connectWs} disabled={wsStatus === 'connecting'}>
                    {wsStatus === 'connected' ? '已连接' : '连接'}
                  </button>
                  <button onClick={disconnectWs} disabled={wsStatus === 'disconnected'}>
                    断开
                  </button>
                </div>
              </div>
            </section>

            {selectedEntity && (
              <section className="panel">
                <div className="panel-title">选中实体</div>
                <div className="form-grid">
                  <label>
                    名称
                    <input
                      value={selectedEntity.name ?? ''}
                      onChange={(e) => updateSelectedEntity({ name: e.target.value })}
                    />
                  </label>
                  <label>
                    X
                    <input
                      type="number"
                      value={selectedEntity.x}
                      onChange={(e) => updateSelectedEntity({ x: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    Y
                    <input
                      type="number"
                      value={selectedEntity.y}
                      onChange={(e) => updateSelectedEntity({ y: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    宽度
                    <input
                      type="number"
                      value={selectedEntity.width}
                      onChange={(e) => updateSelectedEntity({ width: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    高度
                    <input
                      type="number"
                      value={selectedEntity.height}
                      onChange={(e) => updateSelectedEntity({ height: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    缩放
                    <input
                      type="number"
                      step={0.1}
                      value={selectedEntity.scale}
                      onChange={(e) => updateSelectedEntity({ scale: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    旋转(°)
                    <input
                      type="number"
                      step={1}
                      value={selectedEntity.rotation}
                      onChange={(e) => updateSelectedEntity({ rotation: Number(e.target.value) })}
                    />
                  </label>
                  <button className="ghost" onClick={() => setSelectedEntityId(null)}>取消选择</button>
                  <button
                    onClick={() => {
                      setProject((prev) => stampProject({
                        ...prev,
                        entities: prev.entities.filter((e) => e.id !== selectedEntity.id),
                      }))
                      setSelectedEntityId(null)
                    }}
                  >
                    删除实体
                  </button>
                </div>
              </section>
            )}
          </div>
        </aside>

        <section className="canvas-area">
          <div className="canvas-shell" ref={surfaceRef}>
            <canvas
              ref={canvasRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onWheel={handleWheel}
            />
            <div className="hint">左键放置/拖动，右键或中键平移，滚轮缩放，双指可缩放</div>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
