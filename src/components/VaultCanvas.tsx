import { useEffect, useRef } from 'react'

const VERT = `
attribute vec2 aPos;
void main(){ gl_Position = vec4(aPos,0.0,1.0); }
`

const FRAG = `
precision highp float;
uniform vec2  uRes;
uniform float uTime;
uniform vec2  uMouse;
uniform float uOpen;
uniform float uFlash;
const vec3 GOLD = vec3(1.0,0.74,0.32);
const vec3 COOL = vec3(0.42,0.80,1.00);
mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }
float hash(vec2 p){ return fract(sin(dot(p,vec2(41.3,289.1)))*43758.5453); }
float sdBox(vec3 p, vec3 b, float r){
  vec3 q = abs(p)-b;
  return length(max(q,0.0)) + min(max(q.x,max(q.y,q.z)),0.0) - r;
}
float spin(){ return uTime*0.12 + uMouse.x*0.40; }
vec3 toObj(vec3 p){ vec3 q=p; q.xz = rot(spin())*q.xz; return q; }
vec3 lidSpace(vec3 q){
  vec3 lp = q - vec3(0.0, 0.352 + uOpen*0.52, 0.0);
  lp.xy = rot(uOpen*0.42)*lp.xy;
  return lp;
}
vec2 mapScene(vec3 p){
  vec3 q = toObj(p);
  float body = sdBox(q - vec3(0.0,-0.16,0.0), vec3(0.58,0.44,0.58), 0.03);
  float lid  = sdBox(lidSpace(q), vec3(0.605,0.072,0.605), 0.024);
  vec2 r = vec2(body,1.0);
  if(lid < r.x) r = vec2(lid,2.0);
  float fl = p.y + 0.98;
  if(fl < r.x) r = vec2(fl,3.0);
  return r;
}
vec3 calcN(vec3 p){
  vec2 e = vec2(1.0,-1.0)*0.0016;
  return normalize(e.xyy*mapScene(p+e.xyy).x + e.yyx*mapScene(p+e.yyx).x
                 + e.yxy*mapScene(p+e.yxy).x + e.xxx*mapScene(p+e.xxx).x);
}
vec2 trace(vec3 ro, vec3 rd, float tmax){
  float t = 0.03; float id = 0.0;
  for(int i=0;i<84;i++){
    vec3 p = ro + rd*t;
    vec2 h = mapScene(p);
    if(h.x < 0.0010*t + 0.0006){ id = h.y; break; }
    t += h.x*0.9;
    if(t > tmax) break;
  }
  if(t > tmax) id = 0.0;
  return vec2(t,id);
}
float edgeMask(vec3 q, vec3 c, vec3 b){
  vec3 d = abs(abs(q-c)-b);
  float m1 = min(d.x,min(d.y,d.z));
  float m3 = max(d.x,max(d.y,d.z));
  float m2 = d.x + d.y + d.z - m1 - m3;
  return smoothstep(0.030,0.003,m2);
}
vec3 shadeMetal(vec3 p, vec3 n, vec3 rd, float id){
  vec3 q  = toObj(p);
  vec3 L  = normalize(vec3(-0.40,0.86,0.50));
  vec3 L2 = normalize(vec3(0.68,0.22,-0.55));
  float dif  = max(dot(n,L),0.0);
  float dif2 = max(dot(n,L2),0.0);
  vec3 hv = normalize(L-rd);
  float spe  = pow(max(dot(n,hv),0.0),44.0);
  float fres = pow(1.0-max(dot(n,-rd),0.0),4.0);
  vec3 col = vec3(0.044,0.041,0.036)*(0.13+0.87*dif);
  col += vec3(0.07,0.10,0.16)*dif2*0.16;
  col += vec3(1.0,0.95,0.86)*spe*1.05;
  col += mix(GOLD,COOL,clamp(fres*0.85,0.0,1.0))*fres*0.45;
  float e = (id < 1.5)
    ? edgeMask(q, vec3(0.0,-0.16,0.0), vec3(0.58,0.44,0.58))
    : edgeMask(lidSpace(q), vec3(0.0), vec3(0.605,0.072,0.605));
  col += GOLD*e*(0.50 + 0.22*sin(uTime*1.9 + q.y*7.0) + uOpen*1.20);
  float topFace = (id < 1.5) ? smoothstep(0.030,0.0,abs(q.y-0.28)) : 0.0;
  col += mix(GOLD,vec3(1.0,0.98,0.93),uOpen)*topFace*(0.22 + uOpen*7.0);
  float sy = fract(uTime*0.09)*2.9 - 1.45;
  col += COOL*smoothstep(0.022,0.0,abs(q.y-sy))*0.45;
  return col;
}
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*uRes)/uRes.y;
  float aspect = uRes.x/max(uRes.y,1.0);
  float fit = clamp((aspect-0.50)/1.10, 0.0, 1.0);
  uv.y -= mix(0.205,0.135,fit);
  vec3 ro = vec3(uMouse.x*0.24, mix(1.60,1.30,fit) + uMouse.y*0.18, mix(9.60,5.95,fit));
  vec3 ta = vec3(0.0, 0.02, 0.0);
  vec3 fw = normalize(ta-ro);
  vec3 rt = normalize(cross(vec3(0.0,1.0,0.0),fw));
  vec3 up = cross(fw,rt);
  vec3 rd = normalize(uv.x*rt + uv.y*up + 1.75*fw);
  float rr = length(uv*vec2(1.0,1.25));
  vec3 col = mix(vec3(0.028,0.026,0.022), vec3(0.008,0.008,0.010), smoothstep(0.10,1.05,rr));
  vec2 h = trace(ro,rd,16.0);
  float t = h.x, id = h.y;
  if(id > 0.5){
    vec3 p = ro + rd*t;
    vec3 n = calcN(p);
    if(id < 2.5){
      col = shadeMetal(p,n,rd,id);
    } else {
      vec2 g = abs(fract(p.xz*0.6)-0.5);
      float line = smoothstep(0.022,0.0,min(g.x,g.y));
      float fade = exp(-length(p.xz)*0.34);
      col = vec3(0.009,0.009,0.011);
      col += mix(GOLD,COOL,0.30)*line*0.15*fade;
      col += GOLD*exp(-length(p.xz)*2.1)*0.42;
      float ring = smoothstep(0.035,0.0,abs(length(p.xz)-1.30));
      col += GOLD*ring*(0.55 + 0.45*sin(uTime*1.3))*0.55;
      vec3 rd2 = reflect(rd,n);
      vec2 h2 = trace(p + n*0.004, rd2, 6.0);
      if(h2.y > 0.5 && h2.y < 2.5){
        vec3 p2 = p + rd2*h2.x;
        vec3 n2 = calcN(p2);
        col += shadeMetal(p2,n2,rd2,h2.y)*0.42*fade;
      }
    }
  }
  float vol = 0.0;
  float tv = (id > 0.5) ? min(t,7.5) : 7.5;
  for(int i=0;i<22;i++){
    float fi = (float(i)+0.5)/22.0;
    vec3 sp = ro + rd*(fi*tv);
    vec3 sq = toObj(sp);
    float dy = abs(sq.y - 0.30 - uOpen*0.38);
    float ra = length(sq.xz);
    vol += exp(-dy*dy*40.0)*exp(-max(ra-0.60,0.0)*3.0);
  }
  vol  *= (0.009 + uOpen*0.065)*tv/7.5;
  col += mix(GOLD,vec3(1.0,0.96,0.88),uOpen*0.6)*vol;
  col += vec3(1.0,0.95,0.86)*uFlash*0.55;
  col *= 1.0 - 0.62*smoothstep(0.30,1.20,rr);
  col = col/(1.0+col);
  col = pow(max(col,0.0), vec3(0.4545));
  col += (hash(gl_FragCoord.xy + fract(uTime)*97.0) - 0.5)*0.018;
  gl_FragColor = vec4(col,1.0);
}
`

interface VaultCanvasProps {
  openSignal?: number
  holdOpen?: boolean
  onActivate?: () => void
  label?: string
  className?: string
}

type RenderProfile = 'full' | 'balanced' | 'static'

interface NavigatorRenderHints {
  deviceMemory?: number
  connection?: {
    saveData?: boolean
  }
}

const BALANCED_FRAME_INTERVAL = 1000 / 30

function selectRenderProfile(): RenderProfile {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'static'
  if (window.matchMedia('(pointer: coarse)').matches) return 'balanced'

  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const cores = navigator.hardwareConcurrency
  const { deviceMemory, connection } = navigator as Navigator & NavigatorRenderHints
  const modestProcessor = Number.isFinite(cores) && cores > 0 && cores <= 4
  const modestMemory = typeof deviceMemory === 'number'
    && Number.isFinite(deviceMemory)
    && deviceMemory > 0
    && deviceMemory <= 4

  if (
    connection?.saveData === true
    || window.innerWidth < 900
    || dpr > 2
    || modestProcessor
    || modestMemory
  ) return 'balanced'
  return 'full'
}

export function VaultCanvas({
  openSignal = 0,
  holdOpen = false,
  onActivate,
  label = 'Activate boosted demo vault opener',
  className = '',
}: VaultCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fallbackRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<{ setOpen: (open: boolean) => void } | null>(null)
  const usingFallbackRef = useRef(false)

  useEffect(() => {
    const canvas = canvasRef.current
    const fallback = fallbackRef.current
    if (!canvas || !fallback) return
    const showFallback = () => {
      const interactive = canvas.getAttribute('role') === 'button'
      const interactiveLabel = canvas.getAttribute('aria-label')
      canvas.hidden = true
      canvas.removeAttribute('role')
      canvas.tabIndex = -1
      canvas.removeAttribute('aria-label')
      fallback.hidden = false
      if (interactive) {
        fallback.setAttribute('role', 'button')
        fallback.tabIndex = 0
        if (interactiveLabel) fallback.setAttribute('aria-label', interactiveLabel)
      }
      usingFallbackRef.current = true
    }
    const profile = selectRenderProfile()
    canvas.dataset.renderProfile = profile
    const forceFallback = new URLSearchParams(window.location.search).has('nogl')
    let gl: WebGLRenderingContext | null = null
    try {
      if (!forceFallback) {
        gl = canvas.getContext('webgl', {
          antialias: false,
          alpha: false,
          powerPreference: profile === 'full' ? 'high-performance' : 'low-power',
        })
      }
    } catch {
      gl = null
    }
    if (!gl) {
      showFallback()
      return
    }
    let vertex: WebGLShader | null = null
    let fragment: WebGLShader | null = null
    let program: WebGLProgram | null = null
    let buffer: WebGLBuffer | null = null
    let vertexAttached = false
    let fragmentAttached = false
    let resourcesReleased = false
    const safely = (action: () => void) => {
      try {
        action()
      } catch {
        // Lost or partially initialized WebGL contexts may reject cleanup calls.
      }
    }
    const releaseResources = () => {
      if (resourcesReleased) return
      resourcesReleased = true
      safely(() => gl!.bindBuffer(gl!.ARRAY_BUFFER, null))
      safely(() => gl!.useProgram(null))
      if (program && vertex && vertexAttached) {
        safely(() => gl!.detachShader(program!, vertex!))
      }
      if (program && fragment && fragmentAttached) {
        safely(() => gl!.detachShader(program!, fragment!))
      }
      if (buffer) safely(() => gl!.deleteBuffer(buffer!))
      if (program) safely(() => gl!.deleteProgram(program!))
      if (vertex) safely(() => gl!.deleteShader(vertex!))
      if (fragment) safely(() => gl!.deleteShader(fragment!))
      buffer = null
      program = null
      vertex = null
      fragment = null
      vertexAttached = false
      fragmentAttached = false
    }
    const failSetup = () => {
      releaseResources()
      showFallback()
    }
    const compile = (type: number, source: string) => {
      const shader = gl!.createShader(type)
      if (!shader) return null
      gl!.shaderSource(shader, source)
      gl!.compileShader(shader)
      if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
        safely(() => gl!.deleteShader(shader))
        return null
      }
      return shader
    }
    vertex = compile(gl.VERTEX_SHADER, VERT)
    fragment = compile(gl.FRAGMENT_SHADER, FRAG)
    if (!vertex || !fragment) {
      failSetup()
      return
    }
    program = gl.createProgram()
    if (!program) {
      failSetup()
      return
    }
    gl.attachShader(program, vertex)
    vertexAttached = true
    gl.attachShader(program, fragment)
    fragmentAttached = true
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      failSetup()
      return
    }
    gl.useProgram(program)
    buffer = gl.createBuffer()
    if (!buffer) {
      failSetup()
      return
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'aPos')
    if (position < 0) {
      failSetup()
      return
    }
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    const uniforms = {
      res: gl.getUniformLocation(program, 'uRes'),
      time: gl.getUniformLocation(program, 'uTime'),
      mouse: gl.getUniformLocation(program, 'uMouse'),
      open: gl.getUniformLocation(program, 'uOpen'),
      flash: gl.getUniformLocation(program, 'uFlash'),
    }
    let running = true
    let pageVisible = document.visibilityState !== 'hidden'
    let onScreen = true
    let frameId: number | null = null
    let openTarget = 0
    let openNow = 0
    let flash = 0
    let mouseTargetX = 0
    let mouseTargetY = 0
    let mouseX = 0
    let mouseY = 0
    let renderedFrames = 0
    let lastDrawTime = 0
    const resizeDimensions = () => {
      if (!running || resourcesReleased) return
      const dprCap = profile === 'full' ? 1.5 : 1
      const scale = Math.min(window.devicePixelRatio || 1, dprCap)
      const width = Math.max(1, Math.round(canvas.clientWidth * scale))
      const height = Math.max(1, Math.round(canvas.clientHeight * scale))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
        gl!.viewport(0, 0, width, height)
      }
    }
    const draw = (time: number) => {
      if (!running || resourcesReleased) return
      resizeDimensions()
      openNow += (openTarget - openNow) * (profile === 'static' ? 1 : 0.12)
      flash *= 0.86
      mouseX += (mouseTargetX - mouseX) * 0.06
      mouseY += (mouseTargetY - mouseY) * 0.06
      gl!.uniform2f(uniforms.res, canvas.width, canvas.height)
      gl!.uniform1f(uniforms.time, time * 0.001)
      gl!.uniform2f(uniforms.mouse, mouseX, mouseY)
      gl!.uniform1f(uniforms.open, openNow)
      gl!.uniform1f(uniforms.flash, flash)
      gl!.drawArrays(gl!.TRIANGLES, 0, 3)
      lastDrawTime = time
      if (renderedFrames < 2) {
        renderedFrames += 1
        canvas.dataset.webglRenderer = 'live'
        canvas.dataset.webglFrame = String(renderedFrames)
      }
    }
    const stopLoop = () => {
      if (frameId === null) return
      window.cancelAnimationFrame(frameId)
      frameId = null
    }
    const canSchedule = () => (
      running
      && !resourcesReleased
      && profile !== 'static'
      && pageVisible
      && onScreen
    )
    const schedule = () => {
      if (!canSchedule() || frameId !== null) return
      frameId = window.requestAnimationFrame((time) => {
        frameId = null
        if (!canSchedule()) return
        if (profile === 'full' || time - lastDrawTime >= BALANCED_FRAME_INTERVAL) {
          draw(time)
        }
        schedule()
      })
    }
    const onMove = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect()
      mouseTargetX = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2
      mouseTargetY = ((event.clientY - bounds.top) / bounds.height - 0.5) * -2
    }
    const onLeave = () => {
      mouseTargetX = 0
      mouseTargetY = 0
    }
    const onResize = () => {
      if (!running || resourcesReleased) return
      if (profile === 'static') {
        draw(0)
      } else {
        resizeDimensions()
      }
    }
    const onVisibilityChange = () => {
      pageVisible = document.visibilityState !== 'hidden'
      if (pageVisible) {
        schedule()
      } else {
        stopLoop()
      }
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return
      onScreen = entry.isIntersecting
      if (onScreen) {
        schedule()
      } else {
        stopLoop()
      }
    }, { threshold: 0.02 })
    observer.observe(canvas)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerleave', onLeave)
    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVisibilityChange)
    engineRef.current = {
      setOpen(open) {
        if (!running || resourcesReleased) return
        openTarget = open ? 1 : 0
        if (open) flash = 1
        if (profile === 'static') draw(0)
      },
    }
    const onContextLost = (event: Event) => {
      event.preventDefault()
      running = false
      stopLoop()
      releaseResources()
      engineRef.current = null
      showFallback()
    }
    canvas.addEventListener('webglcontextlost', onContextLost)
    draw(0)
    schedule()
    return () => {
      running = false
      stopLoop()
      observer.disconnect()
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('webglcontextlost', onContextLost)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      releaseResources()
      engineRef.current = null
    }
  }, [])

  useEffect(() => {
    const fallback = fallbackRef.current
    if (!fallback) return
    if (usingFallbackRef.current) {
      if (onActivate) {
        fallback.setAttribute('role', 'button')
        fallback.tabIndex = 0
        fallback.setAttribute('aria-label', label)
      } else {
        fallback.removeAttribute('role')
        fallback.tabIndex = -1
        fallback.removeAttribute('aria-label')
        fallback.removeAttribute('aria-pressed')
      }
    }
    const setFallbackOpen = (open: boolean) => {
      fallback.classList.toggle('is-open', open)
      if (onActivate && usingFallbackRef.current) fallback.setAttribute('aria-pressed', String(open))
      const text = fallback.querySelector('.fallback-box span')
      if (text) text.textContent = open ? 'OPEN' : 'TBBC'
    }
    if (holdOpen) {
      setFallbackOpen(true)
      return
    }
    if (!openSignal) {
      setFallbackOpen(false)
      return
    }
    setFallbackOpen(true)
    const fallbackTimeout = window.setTimeout(() => setFallbackOpen(false), 2600)
    return () => window.clearTimeout(fallbackTimeout)
  }, [openSignal, holdOpen, label, onActivate])

  useEffect(() => {
    if (!openSignal) return
    engineRef.current?.setOpen(true)
    if (holdOpen) return
    const timeout = window.setTimeout(() => engineRef.current?.setOpen(false), 2600)
    return () => window.clearTimeout(timeout)
  }, [openSignal, holdOpen])

  const activate = () => onActivate?.()
  return (
    <div className={`vault-canvas-wrap ${className}`}>
      <canvas
        ref={canvasRef}
        className="vault-canvas"
        role={onActivate ? 'button' : undefined}
        tabIndex={onActivate ? 0 : -1}
        aria-label={onActivate ? label : undefined}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            activate()
          }
        }}
      />
      <div
        ref={fallbackRef}
        className="vault-fallback"
        hidden
        data-testid="webgl-fallback"
        tabIndex={-1}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            activate()
          }
        }}
      >
        <div className="fallback-box"><span>TBBC</span></div>
        <div className="containment-ring" />
      </div>
    </div>
  )
}
