import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

/* SINGLE FILE REACT / VITE APP
   1. npm install three
   2. Replace src/App.jsx with this file. No App.css import required.
   3. npm run dev
   Laptop: drag to look, click a component. Phone: drag or Enable immersive view.
   Phone motion needs HTTPS; VR Box uses side-by-side stereo, without WebXR.
   Local records stay in this browser. No camera, backend, API key, or external model.
   Measurements are view-direction dwell and interactions, not eye tracking.
*/
const STORE = 'nexus-ev-evaluation-v2';
const PARTS = ['Instrument cluster', 'Steering controls', 'Infotainment', 'Climate controls', 'Ambient lighting', 'Passenger seat', 'Door controls'];
const DESIGNS = { A: { name: 'Aurora', subtitle: 'Minimal. Connected. Calm.', color: '#42dac0', trim: '#122c35', seat: '#243746', screenX: .45 }, B: { name: 'Solstice', subtitle: 'Warm. Sculpted. Personal.', color: '#edb87f', trim: '#453a32', seat: '#755a49', screenX: .78 } };
const clamp = THREE.MathUtils.clamp;
const makeStats = () => Object.fromEntries(PARTS.map(p => [p, { seconds: 0, selections: 0 }]));
const fmt = n => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
function loadRecords() { try { const a = JSON.parse(localStorage.getItem(STORE) || '[]'); return Array.isArray(a) ? a.filter(s => s && typeof s.id === 'string' && ['A', 'B'].includes(s.design) && s.stats && PARTS.every(p => Number.isFinite(s.stats[p]?.seconds) && Number.isFinite(s.stats[p]?.selections)) && Array.isArray(s.heat) && s.heat.length === 72 && s.heat.every(Number.isFinite) && Number.isFinite(s.duration)).slice(0, 50) : []; } catch { return []; } }
function downloadJSON(value) { const u = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = u; a.download = `EV-evaluation-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); }

export default function App() {
  const mount = useRef(null), sceneAPI = useRef(null);
  const control = useRef({ design: 'A', view: 'interior', drive: false, vr: false, active: false, motion: false, desktopMotion: false });
  const pose = useRef({ q: null, base: null, timestamp: 0, yaw: 0, pitch: 0, source: '', lastOrientationChange: 0, lastMotionSample: 0 });
  const session = useRef(null), recordRef = useRef([]), callbacks = useRef({});
  const [design, setDesign] = useState('A'), [view, setView] = useState('interior');
  const [drive, setDrive] = useState(false), [vr, setVR] = useState(false), [active, setActive] = useState(false), [immersive, setImmersive] = useState(false);
  const [desktopMotionTest, setDesktopMotionTest] = useState(false);
  const [records, setRecords] = useState(loadRecords), [tab, setTab] = useState('experience');
  const [selected, setSelected] = useState(null), [hovered, setHovered] = useState(''), [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0), [speed, setSpeed] = useState(0), [notice, setNotice] = useState('Drag to explore. Select a component to discover its controls.');
  const [motionStatus, setMotionStatus] = useState('off'), [motionReadout, setMotionReadout] = useState({ alpha: 0, beta: 0, gamma: 0, source: 'none' });
  const [feedbackID, setFeedbackID] = useState(null), [rating, setRating] = useState(0), [ease, setEase] = useState(0), [notes, setNotes] = useState('');
  const [reportID, setReportID] = useState(''), [rendererError, setRendererError] = useState('');
  const [interior, setInterior] = useState({ ambient: true, climate: 22, music: false });
  useEffect(() => {
    // Sensor activation is managed by the permission/event pipeline. Preserve it
    // here so an unrelated React render cannot switch motion off mid-session.
    Object.assign(control.current, { design, view, drive, vr, active, desktopMotion: desktopMotionTest, visible: tab === 'experience' });
  }, [design, view, drive, vr, active, desktopMotionTest, tab]);
  useEffect(() => { recordRef.current = records; }, [records]);
  function persist(next) {
    recordRef.current = next; setRecords(next);
    try { localStorage.setItem(STORE, JSON.stringify(next)); }
    catch { setNotice('Browser storage is unavailable or full. Export your report before closing this page.'); }
  }
  function startSession() {
    if (session.current) return;
    const id = globalThis.crypto?.randomUUID?.() || `session-${new Date().toISOString()}`;
    session.current = { id, design, startedAt: new Date().toISOString(), duration: 0, stats: makeStats(), heat: Array(72).fill(0), events: [], source: control.current.motion ? 'phone orientation + touch' : 'pointer / touch', feedback: null };
    control.current.active = true; control.current.drive = true;
    setActive(true); setDrive(true); setElapsed(0); setNotice('Simulation running. Explore the cabin, test the controls, then finish to save your session.');
  }
  function finishSession(askFeedback = true) {
    const s = session.current; if (!s) return;
    const saved = { ...s, endedAt: new Date().toISOString(), stats: structuredClone(s.stats), heat: [...s.heat], events: [...s.events] };
    session.current = null; control.current.active = false; control.current.drive = false; setActive(false); setDrive(false);
    persist([saved, ...recordRef.current].slice(0, 50)); setReportID(saved.id);
    if (askFeedback) { setFeedbackID(saved.id); setRating(0); setEase(0); setNotes(''); }
    setNotice('Session saved on this device. Add feedback or open Reports to inspect it.');
  }
  useEffect(() => {
    callbacks.current = {
      select: name => {
        setSelected(name);
        const s = session.current;
        if (s && s.stats[name]) { s.stats[name].selections++; s.events.push({ component: name, action: 'select', atSeconds: +s.duration.toFixed(2) }); if (s.events.length > 1000) s.events.shift(); }
      },
      action: (component, action) => { const s = session.current; if (s) { s.events.push({ component, action, atSeconds: +s.duration.toFixed(2) }); if (s.events.length > 1000) s.events.shift(); } }
    };
  }, []);
  function changeDesign(next) {
    if (next === design) return;
    if (session.current) finishSession(false);
    setDesign(next); control.current.design = next; setSelected(null);
    setNotice(`Design ${next}: ${DESIGNS[next].name}. Start a new evaluation to record this design.`);
  }
  function disableMotion() {
    pose.current.base = null; pose.current.timestamp = 0; control.current.motion = false; control.current.desktopMotion = false;
    pose.current.source = ''; pose.current.lastOrientationChange = 0; pose.current.lastMotionSample = 0;
    setImmersive(false); setDesktopMotionTest(false); setMotionStatus('off'); setMotionReadout({ alpha: 0, beta: 0, gamma: 0, source: 'none' }); setNotice('Motion control off. Touch, drag, and arrow-key controls are active.');
  }
  function enableDesktopTest(message = 'Desktop motion test is active. Move the cursor across the 3D view to test camera movement.') {
    control.current.motion = false; control.current.desktopMotion = true;
    pose.current.yaw = 0; pose.current.pitch = 0; sceneAPI.current?.center();
    setImmersive(false); setDesktopMotionTest(true); setMotionStatus('desktop');
    setMotionReadout({ alpha: 0, beta: 0, gamma: 0, source: 'cursor tilt' }); setNotice(message);
  }
  async function requestMotion() {
    try {
      control.current.desktopMotion = false; setDesktopMotionTest(false);
      if (!window.isSecureContext) throw new Error('Gyroscope access needs HTTPS (or localhost). Open the secure phone URL and try again.');
      const OrientationEvent = window.DeviceOrientationEvent;
      if (!OrientationEvent) {
        if (window.matchMedia?.('(pointer: fine)').matches) { enableDesktopTest('No laptop gyroscope was detected. Desktop motion test is active instead—move the cursor across the 3D view.'); return true; }
        throw new Error('This browser does not expose device orientation. Touch and drag still work.');
      }
      const policy = document.permissionsPolicy || document.featurePolicy;
      if (policy?.allowsFeature && !policy.allowsFeature('gyroscope')) throw new Error('Gyroscope access is blocked by this page or iframe. Open the app directly in a browser tab.');
      const permissionRequests = [];
      if (typeof OrientationEvent.requestPermission === 'function') permissionRequests.push(OrientationEvent.requestPermission());
      if (typeof window.DeviceMotionEvent?.requestPermission === 'function') permissionRequests.push(window.DeviceMotionEvent.requestPermission());
      if ((await Promise.all(permissionRequests)).some(result => result !== 'granted')) throw new Error('Motion permission was not granted. Allow Motion & Orientation Access, then try again.');
      pose.current.base = null; pose.current.timestamp = 0; pose.current.yaw = 0; pose.current.pitch = 0;
      pose.current.source = ''; pose.current.lastOrientationChange = 0; pose.current.lastMotionSample = 0;
      control.current.motion = true; setImmersive(true); setMotionStatus('waiting');
      setNotice('Gyroscope enabled. Move your phone slowly; the sensor indicator will turn live when readings arrive.');
      window.setTimeout(() => {
        if (control.current.motion && performance.now() - pose.current.timestamp > 2000) {
          control.current.motion = false; setImmersive(false);
          if (window.matchMedia?.('(pointer: fine)').matches) enableDesktopTest('This laptop is not sending gyroscope data. Desktop motion test is active instead—move the cursor across the 3D view.');
          else { setMotionStatus('blocked'); setNotice('Permission was accepted, but no sensor data arrived. Check the browser site permission and device motion setting.'); }
        }
      }, 2400);
      return true;
    } catch (e) {
      control.current.motion = false; setImmersive(false); setMotionStatus('blocked'); setNotice(e.message);
      return false;
    }
  }
  async function enableImmersive() {
    if (control.current.motion || control.current.desktopMotion) { disableMotion(); return; }
    await requestMotion();
  }
  function recenter() { pose.current.base = pose.current.q?.clone() || null; pose.current.yaw = 0; pose.current.pitch = 0; sceneAPI.current?.center(); setNotice(control.current.motion ? 'Gyroscope centered to your current viewing position.' : 'View centered.'); }
  function toggleDrive() {
    if (!session.current) { startSession(); return; }
    const next = !control.current.drive; control.current.drive = next; setDrive(next);
    setNotice(next ? 'Simulation resumed.' : 'Simulation paused. Your evaluation is still recording.');
  }
  async function enterVR() {
    if (!control.current.motion && !(await requestMotion())) return;
    setView('interior'); control.current.view = 'interior'; control.current.vr = true; setVR(true);
    try { await mount.current.parentElement.requestFullscreen?.(); } catch { /* CSS fullscreen remains available. */ }
    try { await window.screen.orientation?.lock?.('landscape'); } catch { setNotice('Rotate your phone to landscape before placing it in the VR Box.'); }
  }
  async function leaveVR() {
    setVR(false); control.current.vr = false;
    try { window.screen.orientation?.unlock?.(); if (document.fullscreenElement) await document.exitFullscreen(); } catch { /* May already be closed. */ }
  }
  useEffect(() => {
    let lastSensorUI = 0;
    const sensor = e => {
      if (!control.current.motion || ![e.alpha, e.beta, e.gamma].every(Number.isFinite)) return;
      const source = e.type === 'deviceorientationabsolute' ? 'absolute orientation' : 'device orientation';
      // Do not alternate between two coordinate systems when a browser emits
      // both event types. Prefer the absolute stream once it is available.
      if (pose.current.source === 'absolute orientation' && source !== 'absolute orientation') return;
      if (source === 'absolute orientation' && pose.current.source !== source) { pose.current.base = null; pose.current.source = source; }
      else if (!pose.current.source) pose.current.source = source;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(e.beta), THREE.MathUtils.degToRad(e.alpha), -THREE.MathUtils.degToRad(e.gamma), 'YXZ'));
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -THREE.MathUtils.degToRad(window.screen.orientation?.angle ?? window.orientation ?? 0)));
      const now = performance.now();
      if (pose.current.q && pose.current.q.angleTo(q) > .00035) pose.current.lastOrientationChange = now;
      pose.current.q = q; pose.current.timestamp = now; if (!pose.current.base) { pose.current.base = q.clone(); pose.current.lastOrientationChange = now; }
      if (now - lastSensorUI > 180) { lastSensorUI = now; setMotionStatus('live'); setMotionReadout({ alpha: Math.round(e.alpha), beta: Math.round(e.beta), gamma: Math.round(e.gamma), source }); }
    };
    const motion = e => {
      if (!control.current.motion || !e.rotationRate) return;
      const now = performance.now(), rate = e.rotationRate;
      const values = [rate.alpha, rate.beta, rate.gamma];
      if (!values.every(Number.isFinite)) return;
      const previous = pose.current.lastMotionSample || now; pose.current.lastMotionSample = now;
      const dt = Math.min((now - previous) / 1000, .05);
      // Some Android WebViews and older phones emit frozen orientation angles
      // while rotationRate remains valid. Integrate that stream only as fallback.
      if (now - pose.current.lastOrientationChange < 350 || dt <= 0) return;
      const angle = ((window.screen.orientation?.angle ?? window.orientation ?? 0) + 360) % 360;
      if (angle === 90 || angle === 270) {
        pose.current.yaw -= THREE.MathUtils.degToRad(rate.beta) * dt * (angle === 90 ? 1 : -1);
        pose.current.pitch = clamp(pose.current.pitch - THREE.MathUtils.degToRad(rate.gamma) * dt, -1.05, 1.05);
      } else {
        pose.current.yaw -= THREE.MathUtils.degToRad(rate.gamma) * dt;
        pose.current.pitch = clamp(pose.current.pitch + THREE.MathUtils.degToRad(rate.beta) * dt, -1.05, 1.05);
      }
      pose.current.timestamp = now;
      if (now - lastSensorUI > 180) { lastSensorUI = now; setMotionStatus('live'); setMotionReadout({ alpha: Math.round(rate.alpha), beta: Math.round(rate.beta), gamma: Math.round(rate.gamma), source: 'rotation-rate fallback' }); }
    };
    const rotate = () => { pose.current.base = null; pose.current.timestamp = 0; sceneAPI.current?.center(); };
    const visible = () => { if (document.hidden) { control.current.drive = false; setDrive(false); } };
    const fullscreen = () => { if (!document.fullscreenElement) { setVR(false); control.current.vr = false; } };
    window.addEventListener('deviceorientation', sensor, true); window.addEventListener('deviceorientationabsolute', sensor, true); window.addEventListener('devicemotion', motion, true); window.addEventListener('orientationchange', rotate); window.screen.orientation?.addEventListener('change', rotate);
    document.addEventListener('visibilitychange', visible); document.addEventListener('fullscreenchange', fullscreen);
    return () => { window.removeEventListener('deviceorientation', sensor, true); window.removeEventListener('deviceorientationabsolute', sensor, true); window.removeEventListener('devicemotion', motion, true); window.removeEventListener('orientationchange', rotate); window.screen.orientation?.removeEventListener('change', rotate); document.removeEventListener('visibilitychange', visible); document.removeEventListener('fullscreenchange', fullscreen); };
  }, []);

  useEffect(() => {
    const host = mount.current;
    let r;
    try { r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }); }
    catch { queueMicrotask(() => setRendererError('3D rendering is unavailable. Enable hardware acceleration or use a WebGL-capable browser.')); return; }
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6)); r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.2;
    host.appendChild(r.domElement);
    const world = new THREE.Scene(); world.background = new THREE.Color('#15212c'); world.fog = new THREE.Fog('#15212c', 50, 170);
    const camera = new THREE.PerspectiveCamera(68, 1, .025, 200), stereo = new THREE.StereoCamera(); stereo.eyeSep = .064;
    world.add(new THREE.HemisphereLight('#e7f4ff', '#3c3c45', 2.8));
    const key = new THREE.DirectionalLight('#fff0df', 3.3); key.position.set(-8, 12, -10); world.add(key);
    const fill = new THREE.DirectionalLight('#8ee5ef', 1.2); fill.position.set(5, 3, 4); world.add(fill);
    const cabin = new THREE.Group(); world.add(cabin);
    const exterior = new THREE.Group(); world.add(exterior); exterior.visible = false;
    const allMats = new Set(), textures = new Set();
    const material = (color, metalness = 0, roughness = .6) => { const m = new THREE.MeshStandardMaterial({ color, metalness, roughness }); allMats.add(m); return m; };
    const black = material('#0c1118', .15, .6), dash = material('#18232d', .1, .75), seatMat = material('#243746', .05, .9), trim = material('#122c35', .25, .5), metal = material('#b6c5cc', .8, .26), bodyMat = material('#42dac0', .7, .27);
    const emissive = (c, intensity = 1.5) => { const m = material(c, .1, .3); m.emissive.set(c); m.emissiveIntensity = intensity; return m; };
    const accent = emissive('#42dac0', 1.3), lamp = emissive('#e4f8ff', 2), tail = emissive('#ff526e', 1.6);
    const targets = {};
    function target(name) { const g = new THREE.Group(); g.userData.component = name; cabin.add(g); targets[name] = g; return g; }
    function box(parent, w, h, d, x, y, z, m) { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); parent.add(o); return o; }
    function cylinder(parent, radius, height, x, y, z, m) { const o = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 32), m); o.position.set(x, y, z); parent.add(o); return o; }
    function screen(parent, width, height, x, y, z, draw) {
      const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = 384;
      const ctx = canvas.getContext('2d'); const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; textures.add(texture);
      const m = new THREE.MeshBasicMaterial({ map: texture }); allMats.add(m);
      box(parent, width + .045, height + .045, .065, x, y, z - .025, black);
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, height), m); plane.position.set(x, y, z + .012); parent.add(plane);
      return { update(...args) { draw(ctx, ...args); texture.needsUpdate = true; }, plane };
    }
    function screenBase(ctx, title) { ctx.fillStyle = '#07131e'; ctx.fillRect(0, 0, 768, 384); ctx.fillStyle = '#62e5cd'; ctx.font = '22px sans-serif'; ctx.fillText(title, 30, 42); }
    // The driver sits at (-.46, 1.25, .45), looking forward along negative Z.
    box(cabin, 2.85, .11, 4.5, 0, .03, 0, black);
    box(cabin, 2.8, .38, .68, 0, .81, -.96, dash);
    box(cabin, 2.75, .07, .8, 0, 1.03, -.97, trim);
    box(cabin, 2.7, .025, .035, 0, 1.072, -.58, accent);
    const ambientTarget = target('Ambient lighting'); box(ambientTarget, .55, .09, .06, .9, 1.03, -.54, accent);
    for (const x of [-1.4, 1.4]) {
      box(cabin, .12, .8, 2.8, x, .53, .1, dash);
      box(cabin, .06, .08, 2.2, x * .965, .94, .2, trim);
      box(cabin, .025, .018, 2.2, x * .94, .99, .2, accent);
      const pillar = box(cabin, .09, .92, .09, x * .94, 1.43, -1.19, dash); pillar.rotation.x = -.24;
      box(cabin, .1, .7, .1, x, 1.45, .6, dash);
    }
    box(cabin, 2.83, .08, .13, 0, 1.91, -1.4, dash);
    box(cabin, 2.8, .08, 1.45, 0, 1.94, .65, dash);
    // Recessed vents and console.
    for (const x of [-1.05, .05, 1.05]) { box(cabin, .32, .08, .05, x, .95, -.595, black); for (let i = 0; i < 4; i++) box(cabin, .28, .008, .01, x, .926 + i * .015, -.56, metal); }
    box(cabin, .38, .48, 1.1, .16, .35, .25, trim);
    box(cabin, .34, .06, .8, .16, .62, .3, black);
    for (const z of [.35, .65]) { cylinder(cabin, .105, .035, .16, .655, z, metal); cylinder(cabin, .083, .037, .16, .66, z, black); }
    const cluster = target('Instrument cluster');
    const clusterScreen = screen(cluster, .68, .28, -.5, 1.1, -.66, (ctx, speedValue = 0) => { screenBase(ctx, 'N E X U S  /  ELECTRIC'); ctx.fillStyle = '#f2faff'; ctx.font = 'bold 128px sans-serif'; ctx.fillText(String(Math.round(speedValue)).padStart(2, '0'), 80, 240); ctx.font = '26px sans-serif'; ctx.fillStyle = '#839ba9'; ctx.fillText('km/h', 280, 235); ctx.fillStyle = '#62e5cd'; ctx.fillRect(480, 112, 170, 9); ctx.font = '24px sans-serif'; ctx.fillText('VIRTUAL DRIVE', 450, 210); ctx.fillStyle = '#8195a3'; ctx.fillText('Concept evaluation', 450, 255); ctx.fillText('Simulation', 35, 345); }); clusterScreen.update(0);
    const infotainment = target('Infotainment');
    const infoScreen = screen(infotainment, .75, .42, .45, 1.17, -.6, (ctx, playing = false, variant = 'A') => { screenBase(ctx, `NEXUS  /  ${DESIGNS[variant].name.toUpperCase()}`); ctx.fillStyle = '#142d3c'; ctx.fillRect(25, 70, 455, 270); ctx.strokeStyle = DESIGNS[variant].color; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(90, 300); ctx.lineTo(180, 240); ctx.lineTo(260, 240); ctx.lineTo(350, 130); ctx.lineTo(430, 100); ctx.stroke(); ctx.fillStyle = '#def8f1'; ctx.beginPath(); ctx.arc(260, 240, 13, 0, Math.PI * 2); ctx.fill(); ctx.font = '23px sans-serif'; ctx.fillText('EXPLORE', 525, 115); ctx.fillStyle = '#8ba6b6'; ctx.fillText('Concept route', 510, 157); ctx.fillStyle = '#62e5cd'; ctx.fillText(playing ? 'PLAYING' : 'AUDIO OFF', 510, 245); ctx.fillStyle = '#8ba6b6'; ctx.font = '19px sans-serif'; ctx.fillText('Interface preview', 510, 285); }); infoScreen.update(false, 'A');
    const climate = target('Climate controls');
    const climateScreen = screen(climate, .62, .13, .45, .83, -.55, (ctx, temp = 22) => { screenBase(ctx, ''); ctx.font = '74px sans-serif'; ctx.fillStyle = '#e1f7ff'; ctx.fillText(`${temp}°`, 80, 240); ctx.font = '38px sans-serif'; ctx.fillStyle = '#62e5cd'; ctx.fillText('CABIN CLIMATE', 295, 220); }); climateScreen.update(22);
    const wheel = target('Steering controls'); wheel.position.set(-.5, .93, -.26); wheel.rotation.x = -.25;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(.235, .026, 12, 48), black); wheel.add(rim);
    box(wheel, .25, .09, .06, 0, 0, 0, trim);
    box(wheel, .045, .2, .04, 0, -.1, 0, metal);
    box(wheel, .07, .04, .015, -.17, 0, .025, metal); box(wheel, .07, .04, .015, .17, 0, .025, metal);
    const door = target('Door controls'); box(door, .07, .09, .37, -1.31, .78, .02, black); box(door, .08, .02, .19, -1.26, .79, .02, metal);
    const passenger = target('Passenger seat');
    function seat(parent, x, z) {
      box(parent, .64, .18, .72, x, .39, z, seatMat);
      const back = box(parent, .66, .73, .17, x, .81, z + .34, seatMat); back.rotation.x = -.12;
      box(parent, .38, .27, .16, x, 1.3, z + .38, seatMat);
      for (const side of [-1, 1]) box(parent, .08, .15, .68, x + side * .29, .49, z, trim);
      for (let j = 0; j < 5; j++) box(parent, .42, .007, .008, x, .6 + j * .085, z + .245, metal);
    }
    seat(passenger, .8, .8); seat(cabin, -.57, .9); seat(cabin, -.65, 1.8); seat(cabin, .65, 1.8);
    box(cabin, .33, .12, .04, .1, 1.65, -1.21, metal);
    // Procedural exterior for the alternate inspection view.
    box(exterior, 1.95, .49, 3.7, 0, .66, 0, bodyMat); box(exterior, 1.84, .14, 3.85, 0, .36, 0, black);
    box(exterior, 1.65, .68, 1.9, 0, 1.16, .05, material('#183745', .6, .15)); box(exterior, 1.74, .08, 1.95, 0, 1.51, .05, bodyMat);
    box(exterior, 1.7, .06, .035, 0, .78, -1.87, lamp); box(exterior, 1.7, .065, .035, 0, .78, 1.87, tail);
    const wheels = [];
    for (const x of [-1, 1]) for (const z of [-1.2, 1.2]) { const pivot = new THREE.Group(); pivot.position.set(x, .4, z); exterior.add(pivot); const tire = new THREE.Mesh(new THREE.CylinderGeometry(.4, .4, .25, 24), black); tire.rotation.z = Math.PI / 2; pivot.add(tire); const hub = new THREE.Mesh(new THREE.CylinderGeometry(.24, .24, .27, 10), metal); hub.rotation.z = Math.PI / 2; pivot.add(hub); wheels.push(pivot); }
    // Landscape visible through open window areas.
    const environment = new THREE.Group(); world.add(environment);
    box(environment, 190, .08, 320, 0, -.12, -90, material('#253c40', 0, 1)); box(environment, 8, .04, 320, 0, -.055, -90, material('#26313c', .1, .9));
    for (const x of [-3.8, 3.8]) box(environment, .05, .01, 320, x, -.025, -90, lamp);
    const stripes = new THREE.Group(); environment.add(stripes);
    for (let j = 0; j < 60; j++) box(stripes, .06, .01, 2.2, 0, -.02, 25 - j * 5, lamp);
    const landscape = new THREE.Group(); environment.add(landscape);
    for (let j = 0; j < 60; j++) {
      const x = (j % 2 ? 1 : -1) * (9 + j % 7), z = 30 - Math.floor(j / 2) * 9, h = 3 + j * 7 % 12;
      box(landscape, 4, h, 4, x, h / 2, z, material(j % 3 ? '#3a5665' : '#344b5a', .25, .8));
      for (let k = 1; k < h; k += 2) box(landscape, 3, .08, .03, x, k, z + 2.02, lamp);
    }
    const ray = new THREE.Raycaster(), v = new THREE.Vector2(0, 0), qRel = new THREE.Quaternion(), euler = new THREE.Euler(0, 0, 0, 'YXZ');
    let dragging = false, dragMoved = false, pointerID = null, px = 0, py = 0, yaw = 0, pitch = 0, currentSpeed = 0, distance = 0;
    let last = 0, reportAt = 0, frame, targetName = '', dwell = 0, fired = false, lastDesign = '', lastView = '', disposed = false;
    let lastSize = { w: 0, h: 0 };
    let currentAmbient = true, currentMusic = false;
    function applyDesign(variant) { const d = DESIGNS[variant]; accent.color.set(currentAmbient ? d.color : '#23313b'); accent.emissive.set(d.color); accent.emissiveIntensity = currentAmbient ? 1.3 : 0; trim.color.set(d.trim); seatMat.color.set(d.seat); bodyMat.color.set(d.color); infotainment.position.x = d.screenX - .45; climate.position.x = d.screenX - .45; infoScreen.update(currentMusic, variant); }
    function center() { pose.current.yaw = 0; pose.current.pitch = 0; yaw = 0; pitch = 0; }
    const c = r.domElement; c.style.touchAction = 'none';
    function pointerDown(e) { if (pointerID !== null) return; pointerID = e.pointerId; dragging = true; dragMoved = false; px = e.clientX; py = e.clientY; c.setPointerCapture(e.pointerId); }
    function pointerMove(e) {
      if (!dragging || e.pointerId !== pointerID) {
        if (control.current.desktopMotion) {
          const rect = c.getBoundingClientRect();
          const nx = clamp((e.clientX - rect.left) / rect.width * 2 - 1, -1, 1);
          const ny = clamp((e.clientY - rect.top) / rect.height * 2 - 1, -1, 1);
          pose.current.yaw = -nx * 1.05; pose.current.pitch = clamp(-ny * .62, -.9, .8);
        }
        return;
      }
      const dx = e.clientX - px, dy = e.clientY - py; if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true; pose.current.yaw -= dx * .004; pose.current.pitch = clamp(pose.current.pitch - dy * .004, -.9, .8); px = e.clientX; py = e.clientY;
    }
    function identify(ndc) {
      ray.setFromCamera(ndc, camera);
      // Raycast against the full cabin so solid geometry correctly occludes targets.
      const hits = ray.intersectObjects(cabin.children, true);
      if (!hits.length) return '';
      let o = hits[0].object;
      while (o && o !== cabin) { if (o.userData.component) return o.userData.component; o = o.parent; }
      return '';
    }
    function select(name) { if (name) callbacks.current.select(name); }
    function pointerUp(e) {
      if (e.pointerId !== pointerID) return;
      if (!dragMoved && control.current.view === 'interior' && !control.current.vr) { const rect = c.getBoundingClientRect(); select(identify(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1))); }
      dragging = false; pointerID = null;
    }
    function pointerCancel() { dragging = false; pointerID = null; }
    const keys = new Set();
    function keydown(e) { if (/INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName)) return; if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); keys.add(e.key); } }
    const keyup = e => keys.delete(e.key), blur = () => { keys.clear(); pointerCancel(); };
    c.addEventListener('pointerdown', pointerDown); c.addEventListener('pointermove', pointerMove); c.addEventListener('pointerup', pointerUp); c.addEventListener('pointercancel', pointerCancel);
    window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup); window.addEventListener('blur', blur);
    function resize() { const w = host.clientWidth, h = host.clientHeight; if (w && h) { r.setSize(w, h, false); lastSize = { w, h }; } }
    const observer = new ResizeObserver(resize); observer.observe(host); resize();
    const api = { center, focus(name) { lastView = 'interior'; if (control.current.motion) { control.current.motion = false; setImmersive(false); } const g = targets[name]; if (!g) return; const pos = new THREE.Vector3(); g.getWorldPosition(pos); // Groups with zero transforms need a geometry-derived center.
      const bounds = new THREE.Box3().setFromObject(g); bounds.getCenter(pos);
      const d = pos.sub(new THREE.Vector3(-.46, 1.25, .45)).normalize(); pose.current.yaw = Math.atan2(-d.x, -d.z); pose.current.pitch = Math.asin(clamp(d.y, -1, 1)); select(name); },
      updateState(s) { currentAmbient = s.ambient; currentMusic = s.music; accent.emissiveIntensity = s.ambient ? 1.3 : 0; accent.color.set(s.ambient ? DESIGNS[control.current.design].color : '#23313b'); infoScreen.update(s.music, control.current.design); climateScreen.update(s.climate); }
    }; sceneAPI.current = api;
    function animate(now) {
      if (disposed) return;
      frame = requestAnimationFrame(animate);
      if (!last) { last = now; reportAt = now; }
      const rawDt = (now - last) / 1000; last = now;
      if (document.hidden || control.current.visible === false || rawDt > .5) { dwell = 0; return; }
      const measuredDt = rawDt, dt = Math.min(rawDt, .05), cfg = control.current;
      if (lastDesign !== cfg.design) { lastDesign = cfg.design; applyDesign(cfg.design); }
      if (lastView !== cfg.view) { lastView = cfg.view; center(); dwell = 0; targetName = ''; fired = false; }
      if (keys.has('ArrowLeft')) pose.current.yaw += dt;
      if (keys.has('ArrowRight')) pose.current.yaw -= dt;
      if (keys.has('ArrowUp')) pose.current.pitch = clamp(pose.current.pitch + dt, -.9, .8);
      if (keys.has('ArrowDown')) pose.current.pitch = clamp(pose.current.pitch - dt, -.9, .8);
      let y = pose.current.yaw, p = pose.current.pitch;
      if (cfg.motion && pose.current.q && pose.current.base && now - pose.current.timestamp < 1200) { qRel.copy(pose.current.base).invert().multiply(pose.current.q); euler.setFromQuaternion(qRel, 'YXZ'); y += euler.y; p += euler.x; }
      y = Math.atan2(Math.sin(y), Math.cos(y)); p = clamp(p, -1.05, 1.05);
      yaw += Math.atan2(Math.sin(y - yaw), Math.cos(y - yaw)) * (1 - Math.exp(-dt * 12)); pitch = THREE.MathUtils.damp(pitch, p, 12, dt);
      currentSpeed = THREE.MathUtils.damp(currentSpeed, cfg.drive ? 32 : 0, 2, dt); distance += currentSpeed / 3.6 * dt;
      stripes.position.z = distance % 5; landscape.position.z = distance % 9;
      wheel.rotation.z = clamp(yaw * .35, -.6, .6); wheels.forEach(w => { w.rotation.x -= currentSpeed / 3.6 * dt / .4; });
      cabin.visible = cfg.view === 'interior'; exterior.visible = !cabin.visible;
      if (cabin.visible) { camera.position.set(-.46, 1.25, .45); camera.rotation.set(pitch, yaw, 0, 'YXZ'); }
      else { const a = yaw + .55; camera.position.set(Math.sin(a) * 5.8, 2.3 + pitch * 2, Math.cos(a) * 5.8); camera.lookAt(0, .8, 0); }
      camera.aspect = (cfg.vr ? lastSize.w / 2 : lastSize.w) / (lastSize.h || 1); camera.updateProjectionMatrix(); camera.updateMatrixWorld(); world.updateMatrixWorld(true);
      const next = cabin.visible ? identify(v) : '';
      if (next !== targetName) { targetName = next; dwell = 0; fired = false; }
      if (next) { dwell += measuredDt; if (cfg.vr && dwell >= 1.5 && !fired) { fired = true; select(next); } }
      if (cfg.vr) { stereo.aspect = 1; stereo.update(camera); const half = Math.floor(lastSize.w / 2); r.setScissorTest(true); r.setViewport(0, 0, half, lastSize.h); r.setScissor(0, 0, half, lastSize.h); r.render(world, stereo.cameraL); r.setViewport(half, 0, lastSize.w - half, lastSize.h); r.setScissor(half, 0, lastSize.w - half, lastSize.h); r.render(world, stereo.cameraR); }
      else { r.setScissorTest(false); r.setViewport(0, 0, lastSize.w, lastSize.h); r.render(world, camera); }
      // Attribute every visible frame to its actual component; UI refresh is throttled separately.
      const s = session.current;
      if (s) {
        s.duration += measuredDt;
        if (next) s.stats[next].seconds += measuredDt;
        if (cabin.visible) { const ix = clamp(Math.floor((yaw + Math.PI) / (Math.PI * 2) * 12), 0, 11); const iy = clamp(Math.floor((Math.PI / 2 - pitch) / Math.PI * 6), 0, 5); s.heat[iy * 12 + ix] += measuredDt; }
      }
      if (now - reportAt > 100) {
        reportAt = now; clusterScreen.update(currentSpeed);
        setHovered(next); setProgress(next ? Math.min(dwell / 1.5, 1) : 0); setSpeed(currentSpeed);
        if (session.current) setElapsed(session.current.duration);
      }
    }
    frame = requestAnimationFrame(animate);
    return () => {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect(); sceneAPI.current = null;
      c.removeEventListener('pointerdown', pointerDown); c.removeEventListener('pointermove', pointerMove); c.removeEventListener('pointerup', pointerUp); c.removeEventListener('pointercancel', pointerCancel);
      window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur);
      const geometries = new Set(); world.traverse(o => { if (o.geometry) geometries.add(o.geometry); }); geometries.forEach(g => g.dispose()); allMats.forEach(m => m.dispose()); textures.forEach(t => t.dispose()); r.dispose(); c.remove();
    };
  }, []);
  useEffect(() => { sceneAPI.current?.updateState(interior); }, [interior, design]);
  function updateInterior(key, value, part) { setInterior(s => ({ ...s, [key]: value })); callbacks.current.action(part, `${key}: ${value}`); }
  const report = records.find(s => s.id === reportID) || records[0];
  const reportTotal = report ? PARTS.reduce((sum, p) => sum + report.stats[p].seconds, 0) : 0;
  const compare = ['A', 'B'].map(key => {
    const list = records.filter(s => s.design === key), rated = list.filter(s => Number.isFinite(s.feedback?.rating));
    return { key, count: list.length, duration: list.reduce((n, s) => n + s.duration, 0), rating: rated.length ? (rated.reduce((n, s) => n + s.feedback.rating, 0) / rated.length).toFixed(1) : '—', rated: rated.length };
  });
  const descriptions = {
    'Instrument cluster': 'A focused digital instrument display. Speed is a virtual animation value.',
    'Steering controls': 'A compact steering layout with integrated controls. The wheel follows your viewing direction during the simulation.',
    'Infotainment': 'Explore navigation and the media interface. Audio below changes the interface preview; it does not play sound.',
    'Climate controls': 'Adjust the cabin temperature interface to evaluate placement and usability.',
    'Ambient lighting': 'Compare the illuminated trim with a quieter interior lighting treatment.',
    'Passenger seat': 'Inspect the seat profile, headrest, upholstery, and cabin arrangement.',
    'Door controls': 'Review the position of the window controls and door armrest.'
  };
  return <div className="nx-app"><style>{CSS}</style>
    <header className="nx-header"><a href="#" className="nx-brand" onClick={e => e.preventDefault()} aria-label="Nexus Motion Lab home"><span className="nx-logo">NX</span><span>NEXUS<small>MOTION LAB / 01</small></span></a><nav aria-label="Primary navigation">{['experience', 'reports', 'compare'].map(t => <button key={t} className={tab === t ? 'on' : ''} onClick={() => { if (t !== 'experience' && session.current) finishSession(false); setTab(t); }}>{t === 'experience' ? 'Drive lab' : t === 'reports' ? 'Telemetry' : 'Concepts'}</button>)}</nav><div className="nx-header-status"><span className={`nx-sensor-dot ${motionStatus}`}/><span>{motionStatus === 'live' ? 'GYRO LIVE' : motionStatus === 'desktop' ? 'DESKTOP TEST' : motionStatus === 'waiting' ? 'CONNECTING' : motionStatus === 'blocked' ? 'GYRO CHECK' : 'LOCAL MODE'}</span></div></header>
    <main><div className="nx-intro"><div><span className="nx-eyebrow">DIGITAL COCKPIT / REAL-TIME STUDY</span><h1>Command the <em>experience.</em></h1><p>Explore two EV concepts, run the drive simulation, and capture every interaction.</p></div><div className="nx-session">{active ? <><i className="recording"/><span>LIVE SESSION</span><b>{fmt(elapsed)}</b></> : <><i/><span>ARCHIVE</span><b>{String(records.length).padStart(2, '0')}</b></>}</div></div>
    <div style={{ display: tab === 'experience' ? 'block' : 'none' }}>
      <div className="nx-workspace"><section className={'nx-viewer ' + (vr ? 'nx-vr ' : '') + (desktopMotionTest ? 'nx-motion-test' : '')}>
        <div className="nx-canvas" ref={mount}/>
        {!vr && <><div className="nx-scene-title"><span className="nx-eyebrow">CONCEPT {design} / {view.toUpperCase()}</span><h2>{DESIGNS[design].name}</h2><small>{drive ? 'SIMULATION IN MOTION' : 'SIMULATION STANDBY'}</small></div><div className="nx-view-toggle"><button className={view === 'interior' ? 'on' : ''} onClick={() => setView('interior')}>Cockpit</button><button className={view === 'exterior' ? 'on' : ''} onClick={() => setView('exterior')}>Vehicle</button></div><div className="nx-center-dot"><i/></div><div className="nx-viewer-bottom"><div className="nx-target-readout"><small>FOCUS TARGET</small><span>{hovered || (view === 'interior' ? 'Drag to scan the cockpit' : 'Drag to orbit the vehicle')}</span></div><div className="nx-speed"><strong>{String(Math.round(speed)).padStart(2, '0')}</strong><span>km/h<small>VIRTUAL</small></span></div></div><div className="nx-scene-tools"><button onClick={recenter}>Center view</button><button className={drive ? 'active' : ''} onClick={toggleDrive}>{drive ? 'Pause motion' : 'Run simulation'}</button></div></>}
        {rendererError && <div className="nx-render-error">{rendererError}</div>}
        {vr && <><div className="nx-vr-line"/>{[25, 75].map(left => <div key={left} className="nx-reticle-wrap" style={{ left: `${left}%` }}><svg width="42" height="42" viewBox="0 0 42 42"><circle cx="21" cy="21" r="17" fill="none" stroke="#ffffff50" strokeWidth="2"/><circle cx="21" cy="21" r="17" fill="none" stroke="#c7f464" strokeWidth="3" strokeDasharray={`${progress * 107} 107`} transform="rotate(-90 21 21)"/><circle cx="21" cy="21" r="2" fill="white"/></svg><span>{hovered || 'Explore the interior'}</span>{selected && <small>{selected}</small>}</div>)}<div className="nx-vr-tools"><button onClick={recenter}>Center</button><button onClick={toggleDrive}>{drive ? 'Pause' : 'Run'}</button><button onClick={leaveVR}>Exit VR</button></div></>}
      </section>
      <aside className="nx-side"><div className="nx-panel-heading"><div><span className="nx-eyebrow">CONTROL DECK</span><h2>Drive setup</h2></div><span className={`nx-state ${drive ? 'live' : ''}`}>{drive ? 'RUNNING' : 'READY'}</span></div><div className="nx-designs">{['A', 'B'].map(k => <button key={k} className={design === k ? 'on' : ''} onClick={() => changeDesign(k)}><i style={{ background: DESIGNS[k].color }}/><span>Concept {k}<b>{DESIGNS[k].name}</b></span><em>{design === k ? 'SELECTED' : 'LOAD'}</em></button>)}</div><div className="nx-system-grid"><div><small>MOTION INPUT</small><strong className={motionStatus}>{motionStatus === 'live' ? 'Gyro live' : motionStatus === 'desktop' ? 'Desktop test' : motionStatus === 'waiting' ? 'Linking' : motionStatus === 'blocked' ? 'Check' : 'Off'}</strong></div><div><small>CONTROL</small><strong>{immersive ? 'Phone motion' : desktopMotionTest ? 'Cursor tilt' : 'Touch / drag'}</strong></div>{(motionStatus === 'live' || motionStatus === 'desktop') && <div className="nx-axis"><small>{desktopMotionTest ? 'LAPTOP CAMERA TEST' : `SENSOR AXIS / ${motionReadout.source.toUpperCase()}`}</small><strong>{desktopMotionTest ? 'MOVE CURSOR OVER VIEW' : `${motionReadout.alpha} / ${motionReadout.beta} / ${motionReadout.gamma}`}</strong></div>}</div><p className="nx-notice" role="status">{notice}</p>
        <div className="nx-stack"><button className="nx-primary" onClick={active ? () => finishSession() : startSession}>{active ? 'Finish & save session' : 'Start drive simulation'}</button><div className="nx-row"><button className={(immersive || desktopMotionTest) ? 'active' : ''} onClick={enableImmersive}>{immersive ? 'Gyroscope on' : desktopMotionTest ? 'Desktop test on' : 'Enable motion input'}</button><button onClick={enterVR}>Enter VR Box</button></div></div>
        <div className="nx-separator"/><div className="nx-section-label">CABIN ZONES <small>SELECT TO FOCUS</small></div><div className="nx-parts">{PARTS.map((p, i) => <button key={p} className={selected === p ? 'on' : ''} onClick={() => { setView('interior'); control.current.view = 'interior'; sceneAPI.current?.focus(p); }}><span>{String(i + 1).padStart(2, '0')}</span>{p}<b>VIEW</b></button>)}</div>
      </aside></div>
      <div className="nx-below"><section className="nx-component"><div className="nx-card-index">01 / INSPECTOR</div><span className="nx-eyebrow">ACTIVE COMPONENT</span><h2>{selected || 'Select a cabin zone'}</h2><p>{selected ? descriptions[selected] : 'Choose a component from the control deck or point the reticle at one inside the cockpit.'}</p>{selected === 'Ambient lighting' && <button className="nx-primary" onClick={() => updateInterior('ambient', !interior.ambient, selected)}>{interior.ambient ? 'Switch lighting off' : 'Switch lighting on'}</button>}{selected === 'Climate controls' && <div className="nx-temp"><button aria-label="Decrease cabin temperature" onClick={() => updateInterior('climate', Math.max(16, interior.climate - 1), selected)}>−</button><strong>{interior.climate}°C</strong><button aria-label="Increase cabin temperature" onClick={() => updateInterior('climate', Math.min(30, interior.climate + 1), selected)}>+</button></div>}{selected === 'Infotainment' && <button onClick={() => updateInterior('music', !interior.music, selected)}>{interior.music ? 'Stop media preview' : 'Preview media playback'}</button>}</section><section className="nx-guide"><div className="nx-card-index">02 / INPUT GUIDE</div><span className="nx-eyebrow">THREE WAYS TO EXPLORE</span><div><b>01</b><p><strong>Desktop control</strong>Drag the scene or use arrow keys. Click a component to inspect it.</p></div><div><b>02</b><p><strong>Phone motion</strong>Open over HTTPS, enable gyroscope, move the phone, then center the view.</p></div><div><b>03</b><p><strong>VR Box</strong>Rotate to landscape. Motion permission is requested before stereo mode starts.</p></div></section></div>
    </div>
    {tab === 'reports' && <section className="nx-report"><div className="nx-section-header"><div><span className="nx-eyebrow">OBSERVE THE EXPERIENCE</span><h2>Session reports</h2></div><button disabled={!records.length} onClick={() => downloadJSON({ schemaVersion: 2, measurement: 'View-direction dwell and explicit interactions; not eye tracking', exportedAt: new Date().toISOString(), sessions: records })}>↓ Export all data</button></div>{!report ? <div className="nx-empty"><h3>Your first evaluation starts here.</h3><p>Explore a concept and finish an evaluation to see real session results.</p><button className="nx-primary" onClick={() => setTab('experience')}>Open experience</button></div> : <><label className="nx-report-picker">Choose a session<select value={report.id} onChange={e => setReportID(e.target.value)}>{records.map(s => <option key={s.id} value={s.id}>{new Date(s.startedAt).toLocaleString()} · {DESIGNS[s.design].name} · {fmt(s.duration)}</option>)}</select></label><div className="nx-metrics"><div><small>CONCEPT</small><strong>{DESIGNS[report.design].name}</strong></div><div><small>ACTIVE VIEWING TIME</small><strong>{fmt(report.duration)}</strong></div><div><small>COMPONENT SELECTIONS</small><strong>{PARTS.reduce((n, p) => n + report.stats[p].selections, 0)}</strong></div><div><small>APPEARANCE RATING</small><strong>{report.feedback?.rating ? `${report.feedback.rating} / 5` : 'Not rated'}</strong></div></div><div className="nx-report-grid"><article className="nx-card"><h3>Component viewing duration</h3><p>Center-of-view time on visible interior components.</p>{PARTS.map(p => <div className="nx-bar" key={p}><div><span>{p}</span><b>{report.stats[p].seconds.toFixed(1)} s</b></div><div className="nx-track"><i style={{ width: `${reportTotal ? report.stats[p].seconds / reportTotal * 100 : 0}%` }}/></div></div>)}</article><article className="nx-card"><h3>View-direction map</h3><p>Time spent looking in each cabin direction. Brighter cells indicate longer viewing.</p><div className="nx-heat">{report.heat.map((n, i) => <div key={i} title={`${n.toFixed(2)} seconds`} style={{ background: `rgba(68,225,194,${.04 + .96 * n / Math.max(...report.heat, .01)})` }}/>)}</div><div className="nx-map-labels"><span>Behind / left</span><span>Forward</span><span>Right / behind</span></div><p className="nx-fine">Top: upward · Bottom: downward. Viewing direction is an attention proxy; it does not measure eye movement.</p><h3>Session observations</h3><p>{reportTotal > 0 ? `The longest viewed component was ${[...PARTS].sort((a, b) => report.stats[b].seconds - report.stats[a].seconds)[0].toLowerCase()}. Viewing duration alone does not indicate preference.` : 'No interior component viewing was recorded. Try inspecting the cabin in your next session.'}</p><p>{report.feedback?.notes || 'No written feedback added.'}</p><button onClick={() => { setFeedbackID(report.id); setRating(report.feedback?.rating || 0); setEase(report.feedback?.ease || 0); setNotes(report.feedback?.notes || ''); }}>Edit feedback</button></article></div><article className="nx-card nx-events"><h3>Interaction sequence</h3>{report.events.length ? <div className="nx-table-wrap"><table><thead><tr><th>Time</th><th>Component</th><th>Action</th></tr></thead><tbody>{report.events.slice(-50).map((e, i) => <tr key={i}><td>{fmt(e.atSeconds)}</td><td>{e.component}</td><td>{e.action}</td></tr>)}</tbody></table></div> : <p>No selections recorded in this session.</p>}</article></> }</section>}
    {tab === 'compare' && <section className="nx-report"><div className="nx-section-header"><div><span className="nx-eyebrow">TWO IDEAS. YOUR PERSPECTIVE.</span><h2>Compare concepts</h2></div></div><div className="nx-comparison">{compare.map(c => <article className="nx-card" key={c.key}><div className="nx-swatch" style={{ background: `linear-gradient(135deg, ${DESIGNS[c.key].trim}, ${DESIGNS[c.key].color})` }}><span>{c.key}</span></div><span className="nx-eyebrow">CONCEPT {c.key}</span><h2>{DESIGNS[c.key].name}</h2><p>{DESIGNS[c.key].subtitle}</p><dl><div><dt>Recorded sessions</dt><dd>{c.count}</dd></div><div><dt>Total active viewing</dt><dd>{fmt(c.duration)}</dd></div><div><dt>Mean appearance rating</dt><dd>{c.rating}{c.rated ? ' / 5' : ''}</dd></div><div><dt>Rated sessions</dt><dd>{c.rated}</dd></div></dl><button onClick={() => { changeDesign(c.key); setTab('experience'); }}>Explore concept {c.key} ↗</button></article>)}</div><p className="nx-fine">Ratings come from user feedback. Sessions on this device are compared descriptively; repeated sessions may belong to the same person.</p></section>}
    <footer><span>NEXUS / EV DESIGN EVALUATION</span><span>View-direction analysis · Local session history · No camera access</span></footer></main>
    {feedbackID && <div className="nx-modal-backdrop"><section className="nx-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-title"><div className="nx-eyebrow">YOUR PERSPECTIVE MATTERS</div><h2 id="feedback-title">How did it feel?</h2><p>Add your feedback to this evaluation.</p><label>Appearance rating</label><div className="nx-rating">{[1, 2, 3, 4, 5].map(n => <button key={n} className={rating === n ? 'on' : ''} aria-label={`Appearance ${n} out of 5`} onClick={() => setRating(n)}>{n}</button>)}</div><label>Ease of finding controls</label><div className="nx-rating">{[1, 2, 3, 4, 5].map(n => <button key={n} className={ease === n ? 'on' : ''} aria-label={`Ease ${n} out of 5`} onClick={() => setEase(n)}>{n}</button>)}</div><label htmlFor="nx-notes">What worked? What would you change?</label><textarea id="nx-notes" maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Your observations…"/><div className="nx-row"><button onClick={() => setFeedbackID(null)}>Skip for now</button><button className="nx-primary" onClick={() => { persist(recordRef.current.map(s => s.id === feedbackID ? { ...s, feedback: { rating: rating || null, ease: ease || null, notes: notes.trim() } } : s)); setFeedbackID(null); }}>Save feedback</button></div></section></div>}
  </div>;
}

const CSS = `
*{box-sizing:border-box}html,body,#root{margin:0;width:100%;max-width:none;min-height:100%;padding:0;text-align:left}body{background:#0b1118}button,input,textarea,select{font:inherit}button{cursor:pointer;border:1px solid #2b3c49;background:#17232e;color:#c7d6df;padding:11px 14px;border-radius:9px;font-size:11px;font-weight:600;transition:background .18s}button:hover{background:#243c48}button:disabled{opacity:.4;cursor:not-allowed}button:focus-visible,a:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid #51dfc4;outline-offset:3px}.nx-app{font-family:Inter,'Segoe UI',Arial,sans-serif;color:#e8f1f6;min-height:100vh;background:radial-gradient(ellipse at 70% 0,#18303c55,transparent 50%),#0b1118}.nx-header{height:86px;padding:0 5%;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #21303a;gap:20px}.nx-brand{display:flex;gap:12px;align-items:center;color:#e7f5fb;text-decoration:none;font-size:19px;letter-spacing:3px;font-weight:700}.nx-logo{border:1px solid #4bdcb954;border-radius:10px;padding:8px 11px;font-size:24px;color:#4bdcbd}.nx-brand small{display:block;font-size:8px;letter-spacing:1.8px;font-weight:400;color:#7893a4;margin-top:5px}.nx-header nav{display:flex;gap:8px}.nx-header nav button{background:transparent;border-color:transparent;color:#718c9c;font-size:11px}.nx-header nav button.on{color:#70e4ca;background:#42dac010}.nx-local{font-size:8px;letter-spacing:1.8px;color:#7795a5;display:flex;align-items:center;gap:8px}.nx-local i,.nx-session i{width:6px;height:6px;border-radius:50%;background:#42dac0;display:inline-block}.nx-app main{max-width:1530px;padding:36px 5% 20px;margin:auto}.nx-intro{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px}.nx-eyebrow{font-size:9px;font-weight:600;letter-spacing:2px;color:#4bdcbd}h1{font-size:clamp(30px,3.2vw,46px);letter-spacing:-1.8px;font-weight:500;margin:14px 0 9px;line-height:1.15}h1 em{font-style:normal;color:#7793a4}.nx-intro p{font-size:12px;color:#728c9d;margin:0}.nx-session{display:flex;align-items:center;gap:8px;font-size:9px;letter-spacing:1px;color:#8ba4b3;padding:10px 13px;border:1px solid #293b48;border-radius:20px}.nx-session b{color:#e5f6fd;margin-left:8px}.nx-session i.recording{background:#ff6b78;box-shadow:0 0 10px #ff6b7870}.nx-workspace{display:grid;grid-template-columns:minmax(0,1fr) 325px;gap:20px}.nx-viewer{position:relative;min-height:615px;overflow:hidden;border:1px solid #304450;border-radius:15px;background:#172530}.nx-canvas{position:absolute;inset:0}.nx-canvas canvas{display:block;width:100%;height:100%;cursor:grab}.nx-canvas canvas:active{cursor:grabbing}.nx-scene-title{position:absolute;top:25px;left:26px;pointer-events:none;text-shadow:0 2px 8px #000}.nx-scene-title h2{font-size:29px;margin:7px 0;font-weight:500;letter-spacing:-1px}.nx-scene-title small{font-size:8px;letter-spacing:2px;color:#acbec8}.nx-view-toggle{position:absolute;right:20px;top:23px;display:flex;padding:3px;background:#101e29d9;border:1px solid #3d505b;border-radius:10px}.nx-view-toggle button{background:none;border:0;padding:7px 12px;font-size:10px;color:#8ba4b3}.nx-view-toggle button.on{background:#334b58;color:#eefaff}.nx-center-dot{position:absolute;left:50%;top:50%;width:5px;height:5px;transform:translate(-50%,-50%);border-radius:50%;background:#ffffffd0;box-shadow:0 0 0 5px #00000028;pointer-events:none}.nx-viewer-bottom{position:absolute;bottom:22px;left:25px;right:25px;display:flex;justify-content:space-between;gap:20px;font-size:11px;align-items:center;color:#d0e1e8;pointer-events:none;text-shadow:0 2px 6px #000}.nx-viewer-bottom small{font-size:8px;color:#8fb1bf;letter-spacing:1px}.nx-scene-tools{position:absolute;left:22px;bottom:65px;display:flex;gap:7px}.nx-scene-tools button{font-size:9px;background:#10202bcd;border-color:#4d626e;padding:8px 11px}.nx-side{border:1px solid #293c49;background:#101b26;border-radius:15px;padding:23px}.nx-side h2{font-size:23px;font-weight:500;letter-spacing:-.8px;margin:11px 0 21px}.nx-designs{display:grid;grid-template-columns:1fr 1fr;gap:9px}.nx-designs button{display:flex;gap:9px;align-items:center;padding:12px 10px;text-align:left;background:#0c1722}.nx-designs button.on{border-color:#49dcbf80;background:#42dac00d}.nx-designs i{width:10px;height:26px;border-radius:3px;flex-shrink:0}.nx-designs span{color:#7d9aaa;font-size:9px}.nx-designs b{display:block;color:#e0eef4;margin-top:4px;font-weight:500;font-size:12px}.nx-notice{font-size:10px;color:#7895a6;line-height:1.8;min-height:51px;margin:16px 0}.nx-stack{display:flex;flex-direction:column;gap:8px}.nx-primary{background:#48dabe;color:#0b2928;border-color:#48dabe}.nx-primary:hover{background:#7aeed6}.nx-row{display:flex;gap:8px}.nx-row>*{flex:1}.nx-row button{font-size:10px;padding:10px 6px}.nx-separator{height:1px;background:#273947;margin:23px 0 18px}.nx-section-label{font-size:9px;color:#a9bdc9;letter-spacing:1.5px}.nx-section-label small{display:block;font-size:7px;color:#56788d;letter-spacing:1.2px;margin-top:6px}.nx-parts{display:flex;flex-direction:column;margin-top:12px;gap:5px}.nx-parts button{display:flex;align-items:center;gap:12px;text-align:left;padding:10px 9px;background:transparent;border-color:transparent;font-size:10px;color:#8ba4b4}.nx-parts button span{font-size:8px;color:#486b7f}.nx-parts button b{margin-left:auto;font-size:12px;color:#537f91}.nx-parts button.on{background:#42dac00e;color:#69dfc7;border-color:#42dac023}.nx-below{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:20px}.nx-component,.nx-guide{border:1px solid #273946;background:#101a24;border-radius:13px;padding:25px}.nx-component h2{font-size:23px;letter-spacing:-.5px;font-weight:500;margin:12px 0}.nx-component p,.nx-guide p{font-size:11px;line-height:1.8;color:#809bac}.nx-component p{max-width:500px}.nx-component>button{margin-top:8px}.nx-guide>div:not(.nx-eyebrow){display:flex;gap:16px;align-items:flex-start;margin-top:15px}.nx-guide b{font-size:10px;color:#4bdcbd;margin-top:3px}.nx-guide p{margin:0}.nx-guide strong{display:block;color:#d2e5ee;font-size:11px;font-weight:500}.nx-temp{display:flex;align-items:center;gap:22px;margin-top:20px}.nx-temp strong{font-size:25px;font-weight:500}.nx-app footer{display:flex;justify-content:space-between;gap:15px;margin-top:30px;color:#4d6b7f;font-size:8px;letter-spacing:1px;line-height:1.7}.nx-vr{position:fixed!important;inset:0!important;width:100vw!important;height:100dvh!important;z-index:999!important;min-height:0!important;border:0!important;border-radius:0!important}.nx-viewer:fullscreen{width:100vw;height:100dvh;border-radius:0}.nx-vr-line{position:absolute;left:50%;top:0;bottom:0;width:2px;background:#000;pointer-events:none}.nx-reticle-wrap{position:absolute;top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;pointer-events:none;color:#dcfff5;text-shadow:0 1px 5px black;font-size:10px;gap:8px;width:180px}.nx-reticle-wrap small{color:#78efce;font-size:8px}.nx-vr-tools{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);display:flex;gap:7px}.nx-vr-tools button{font-size:9px;background:#0e2330b0;padding:7px 10px}.nx-report{border-top:1px solid #253744;padding-top:25px}.nx-section-header{display:flex;justify-content:space-between;gap:15px;align-items:center;margin-bottom:25px}.nx-section-header h2{font-weight:500;font-size:29px;letter-spacing:-1px;margin:12px 0}.nx-empty{text-align:center;padding:70px 20px;background:#111f2a;border-radius:15px}.nx-empty h3{font-size:24px;font-weight:400}.nx-empty p{font-size:12px;color:#829fac;margin-bottom:25px}.nx-report-picker{font-size:11px;color:#8ca6b6;display:block;max-width:530px}.nx-report-picker select{display:block;width:100%;margin:10px 0 25px;padding:12px;background:#132431;border:1px solid #324a58;border-radius:9px;color:#d4e6ef}.nx-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:15px;margin-bottom:20px}.nx-metrics>div{background:#11212c;border:1px solid #2a3f4c;padding:22px;border-radius:12px}.nx-metrics small{font-size:8px;letter-spacing:1px;color:#7596a8}.nx-metrics strong{display:block;font-size:27px;font-weight:400;color:#d8eee9;margin-top:10px}.nx-report-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.nx-card{padding:25px;background:#101d28;border:1px solid #2a3c4a;border-radius:13px}.nx-card h3{font-size:16px;font-weight:500;margin:0 0 10px}.nx-card p{color:#829eaf;font-size:11px;line-height:1.8}.nx-bar{margin-top:22px}.nx-bar>div:first-child{display:flex;justify-content:space-between;gap:12px;font-size:11px;color:#a2b7c4}.nx-bar b{font-weight:400;color:#60d7bc}.nx-track{height:5px;background:#233a49;border-radius:5px;margin-top:10px;overflow:hidden}.nx-track i{height:100%;display:block;background:#46d7b8;border-radius:5px}.nx-heat{display:grid;grid-template-columns:repeat(12,1fr);gap:4px;margin-top:20px}.nx-heat>div{aspect-ratio:1.4;border-radius:3px}.nx-map-labels{display:flex;justify-content:space-between;font-size:8px;color:#6b8b9e;margin:10px 0}.nx-fine{font-size:10px!important;color:#66889b!important;line-height:1.8}.nx-events{margin-top:20px}.nx-table-wrap{overflow:auto;max-height:350px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{text-align:left;padding:12px;border-bottom:1px solid #263b49}th{color:#75bba9;font-size:9px;font-weight:500}td{color:#9db5c4}.nx-comparison{display:grid;grid-template-columns:1fr 1fr;gap:25px}.nx-swatch{height:140px;border-radius:9px;margin-bottom:25px;display:flex;align-items:center;justify-content:center}.nx-swatch span{font-size:80px;color:#ffffff60;font-weight:300}.nx-comparison h2{font-size:32px;font-weight:400;margin:12px 0}.nx-comparison dl{margin:25px 0}.nx-comparison dl>div{display:flex;justify-content:space-between;border-top:1px solid #29404e;padding:14px 0;font-size:11px}.nx-comparison dt{color:#819dad}.nx-comparison dd{margin:0;color:#d4eae4}.nx-modal-backdrop{position:fixed;inset:0;z-index:2000;background:#030a12bd;display:grid;place-items:center;padding:20px;backdrop-filter:blur(8px)}.nx-modal{width:min(100%,460px);max-height:92dvh;overflow:auto;background:#132431;border:1px solid #3a5361;border-radius:17px;padding:30px}.nx-modal h2{font-size:29px;font-weight:400;margin:12px 0}.nx-modal p{font-size:12px;color:#7897aa}.nx-modal label{display:block;font-size:11px;color:#a4bdcb;margin:22px 0 10px}.nx-rating{display:flex;gap:8px}.nx-rating button{flex:1;font-size:14px}.nx-rating button.on{border-color:#49ddc0;color:#49ddc0;background:#49ddc01a}.nx-modal textarea{width:100%;min-height:95px;resize:vertical;background:#0c1b27;border:1px solid #304959;border-radius:8px;color:#d2e9f0;padding:12px;font-size:12px;margin-bottom:20px}.nx-render-error{position:absolute;inset:30% 10% auto;padding:25px;background:#183244;color:#ffc7c7;border-radius:10px;font-size:14px}
@media(min-width:1500px){.nx-app main{padding-left:45px;padding-right:45px}}@media(max-width:1050px){.nx-local{display:none}.nx-workspace{grid-template-columns:minmax(0,1fr) 290px}.nx-side{padding:18px}.nx-view-toggle{top:120px;right:auto;left:22px}.nx-scene-title{left:22px}.nx-metrics strong{font-size:22px}.nx-metrics>div{padding:16px}}@media(max-width:740px){.nx-header{height:auto;min-height:95px;flex-wrap:wrap;padding:16px 20px 10px;gap:14px}.nx-brand{font-size:15px}.nx-logo{font-size:19px;padding:6px 10px}.nx-header nav{width:100%;gap:4px}.nx-header nav button{flex:1;padding:8px 6px;font-size:10px}.nx-app main{padding:26px 18px 20px}.nx-intro{gap:12px;align-items:flex-start}.nx-intro .nx-eyebrow{font-size:7px;letter-spacing:1.4px}.nx-intro h1{font-size:30px;letter-spacing:-1px}.nx-session{font-size:7px;padding:8px;letter-spacing:0;white-space:nowrap;gap:5px;margin-top:4px}.nx-session b{margin-left:0}.nx-workspace{grid-template-columns:1fr;gap:15px}.nx-viewer{min-height:420px}.nx-scene-title h2{font-size:25px}.nx-view-toggle{top:22px;left:auto;right:15px}.nx-view-toggle button{font-size:9px;padding:6px 9px}.nx-side{padding:22px}.nx-notice{min-height:0}.nx-parts{display:grid;grid-template-columns:1fr 1fr;gap:7px}.nx-parts button{padding:11px 6px;font-size:9px;gap:6px}.nx-parts button b{font-size:10px}.nx-below{grid-template-columns:1fr;gap:15px;margin-top:15px}.nx-component,.nx-guide{padding:23px}.nx-app footer{flex-direction:column;gap:6px;font-size:7px}.nx-metrics{grid-template-columns:1fr 1fr;gap:10px}.nx-metrics small{font-size:7px}.nx-metrics strong{font-size:22px}.nx-report-grid,.nx-comparison{grid-template-columns:1fr}.nx-section-header h2{font-size:25px}.nx-section-header>button{font-size:9px;padding:9px}.nx-card{padding:20px}.nx-guide p{font-size:11px}.nx-vr .nx-canvas{inset:0}button{min-height:36px}}@media(max-width:390px){.nx-intro{display:block}.nx-session{display:inline-flex;margin-top:15px}.nx-view-toggle{top:115px;left:22px;right:auto}}@media(prefers-reduced-motion:reduce){button{transition:none}}

/* 2026 motion-lab interface */
:root{color-scheme:dark;--nx-bg:#070908;--nx-panel:#101310;--nx-panel-2:#151915;--nx-line:#2b302b;--nx-muted:#8d958c;--nx-text:#f1f4ed;--nx-lime:#c7f464;--nx-lime-dark:#1c2610;--nx-blue:#77b7ff}
body{background:var(--nx-bg)}
#root{border:0;display:block}
button{border:1px solid #353b35;background:#171b17;color:#e8ece4;border-radius:4px;padding:12px 15px;font-size:11px;letter-spacing:.02em;transition:background .18s,border-color .18s,color .18s,transform .18s}
button:hover{background:#202620;border-color:#596159}button:active{transform:translateY(1px)}button.active{border-color:#829e46;color:var(--nx-lime);background:#1a2114}button:focus-visible,a:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--nx-lime);outline-offset:3px}
.nx-app{font-family:"Segoe UI",Inter,Arial,sans-serif;color:var(--nx-text);background:radial-gradient(circle at 72% 4%,#24301b 0,transparent 24%),linear-gradient(180deg,#0b0e0b 0,#070908 55%);min-height:100vh}
.nx-app h1,.nx-app h2,.nx-app h3{color:var(--nx-text)}
.nx-header{height:76px;padding:0 clamp(20px,4vw,64px);border-bottom:1px solid var(--nx-line);background:#090b09e8;backdrop-filter:blur(18px);position:sticky;top:0;z-index:100}
.nx-brand{gap:13px;color:var(--nx-text);font-size:16px;letter-spacing:.25em}.nx-logo{display:grid;place-items:center;width:38px;height:38px;padding:0;border-radius:2px;border:1px solid #66735c;color:var(--nx-lime);font-size:12px;letter-spacing:-.02em;background:linear-gradient(145deg,#1e2519,#0d100c)}.nx-brand small{font-size:7px;letter-spacing:.22em;color:#747d73;margin-top:4px}
.nx-header nav{height:100%;align-items:stretch;gap:0}.nx-header nav button{border:0;border-bottom:2px solid transparent;border-radius:0;background:none;color:#737b72;padding:0 22px;font-size:10px;text-transform:uppercase;letter-spacing:.12em}.nx-header nav button:hover{color:#c8cec5;background:#111511}.nx-header nav button.on{color:var(--nx-text);background:#101310;border-bottom-color:var(--nx-lime)}
.nx-header-status{display:flex;align-items:center;gap:9px;font-size:8px;letter-spacing:.16em;color:#8b9389}.nx-sensor-dot{width:7px;height:7px;border-radius:50%;background:#697068}.nx-sensor-dot.live{background:var(--nx-lime);box-shadow:0 0 14px #c7f464aa}.nx-sensor-dot.desktop{background:var(--nx-blue);box-shadow:0 0 14px #77b7ff88}.nx-sensor-dot.waiting{background:#f2bf62;animation:nxPulse 1s infinite}.nx-sensor-dot.blocked{background:#ff745f}@keyframes nxPulse{50%{opacity:.35}}
.nx-app main{max-width:1600px;margin:auto;padding:46px clamp(20px,4vw,64px) 24px}.nx-intro{margin-bottom:31px;align-items:flex-end}.nx-eyebrow{font-size:8px;letter-spacing:.22em;color:var(--nx-lime);font-weight:700}.nx-intro h1{font-size:clamp(38px,4.4vw,70px);font-weight:300;letter-spacing:-.055em;line-height:.98;margin:14px 0 16px}.nx-intro h1 em{color:#899087;font-style:normal}.nx-intro p{font-size:12px;line-height:1.6;color:#7f877d;max-width:560px}
.nx-session{min-width:170px;justify-content:flex-start;border:1px solid #313731;background:#0d100d;border-radius:3px;padding:13px 15px;font-size:8px;letter-spacing:.14em;color:#858e83}.nx-session i{width:7px;height:7px;background:#65705f}.nx-session i.recording{background:#ff6e62;box-shadow:0 0 12px #ff6e6277}.nx-session b{margin-left:auto;font-family:Consolas,monospace;color:var(--nx-text);font-size:13px;letter-spacing:.04em}
.nx-workspace{grid-template-columns:minmax(0,1fr) 350px;gap:14px}.nx-viewer{min-height:660px;border:1px solid #343b34;border-radius:5px;background:#121612;box-shadow:0 28px 70px #0008}.nx-viewer:after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,#04070455 0,transparent 30%,transparent 60%,#050705bb 100%)}.nx-canvas{z-index:0}.nx-scene-title,.nx-view-toggle,.nx-center-dot,.nx-viewer-bottom,.nx-scene-tools,.nx-render-error{z-index:2}
.nx-motion-test .nx-canvas canvas{cursor:crosshair}.nx-motion-test .nx-center-dot{border-color:#77b7ffaa}.nx-motion-test .nx-center-dot i{background:var(--nx-blue);box-shadow:0 0 8px var(--nx-blue)}
.nx-scene-title{top:27px;left:29px}.nx-scene-title h2{font-size:34px;font-weight:300;letter-spacing:-.04em;margin:8px 0 7px}.nx-scene-title small{font-size:8px;letter-spacing:.16em;color:#c3cbc0}.nx-view-toggle{top:25px;right:25px;padding:3px;border-radius:3px;border-color:#4b544b;background:#0b0e0bcc}.nx-view-toggle button{border:0;border-radius:2px;background:none;color:#858d83;padding:8px 14px}.nx-view-toggle button.on{background:var(--nx-lime);color:#12170d}
.nx-center-dot{width:30px;height:30px;border:1px solid #dfffa955;background:transparent;box-shadow:none;display:grid;place-items:center}.nx-center-dot:before,.nx-center-dot:after{content:"";position:absolute;background:#dfffa966}.nx-center-dot:before{width:42px;height:1px}.nx-center-dot:after{height:42px;width:1px}.nx-center-dot i{width:4px;height:4px;background:var(--nx-lime);border-radius:50%;box-shadow:0 0 8px var(--nx-lime)}
.nx-viewer-bottom{bottom:24px;left:28px;right:28px;align-items:flex-end}.nx-target-readout{display:flex;flex-direction:column;gap:7px}.nx-target-readout small{font-size:7px;letter-spacing:.18em;color:#8e9989}.nx-target-readout span{font-size:12px;color:#f1f5ed}.nx-speed{display:flex;align-items:flex-end;gap:8px}.nx-speed strong{font:300 55px/.75 Consolas,monospace;letter-spacing:-.08em}.nx-speed>span{font-size:10px;color:var(--nx-lime);line-height:1}.nx-speed small{display:block;font-size:6px;color:#858d83;letter-spacing:.14em;margin-top:5px}
.nx-scene-tools{left:28px;bottom:86px}.nx-scene-tools button{background:#0b0e0bca;border-color:#495149;font-size:9px;text-transform:uppercase;letter-spacing:.1em}.nx-scene-tools button.active{color:#0f1509;background:var(--nx-lime);border-color:var(--nx-lime)}
.nx-side{border:1px solid #303630;background:var(--nx-panel);border-radius:5px;padding:25px;box-shadow:0 25px 60px #0006}.nx-panel-heading{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}.nx-side h2{font-size:27px;font-weight:300;letter-spacing:-.04em;margin:8px 0 0}.nx-state{font-size:7px;letter-spacing:.16em;color:#889086;border:1px solid #3c433b;padding:7px 8px;border-radius:2px}.nx-state.live{color:#10150b;background:var(--nx-lime);border-color:var(--nx-lime)}
.nx-designs{gap:7px}.nx-designs button{position:relative;display:grid;grid-template-columns:7px 1fr;padding:12px;text-align:left;background:#0c0f0c;border-color:#303630;border-radius:3px}.nx-designs button.on{border-color:#879d58;background:#161d12}.nx-designs i{width:7px;height:37px;border-radius:1px;grid-row:1/3}.nx-designs span{font-size:7px;letter-spacing:.12em;color:#7d857b}.nx-designs b{font-size:12px;color:#eef2ea;margin-top:4px}.nx-designs em{grid-column:2;font-size:6px;letter-spacing:.15em;color:#66705f;font-style:normal;margin-top:5px}.nx-designs button.on em{color:var(--nx-lime)}
.nx-system-grid{display:grid;grid-template-columns:1fr 1fr;margin-top:10px;border:1px solid #2a302a}.nx-system-grid>div{padding:11px 12px;background:#0b0e0b}.nx-system-grid>div+div{border-left:1px solid #2a302a}.nx-system-grid small{display:block;font-size:6px;letter-spacing:.15em;color:#666f65;margin-bottom:5px}.nx-system-grid strong{font-size:10px;font-weight:500;color:#dce2d8}.nx-system-grid strong.live{color:var(--nx-lime)}.nx-system-grid strong.desktop{color:var(--nx-blue)}.nx-system-grid strong.blocked{color:#ff806d}.nx-system-grid .nx-axis{grid-column:1/-1;border-left:0;border-top:1px solid #2a302a}.nx-axis strong{font-family:Consolas,monospace;color:var(--nx-blue)}
.nx-notice{min-height:58px;margin:13px 0;padding:11px 12px;border-left:2px solid #56614e;background:#0b0e0b;color:#899187;font-size:9px;line-height:1.65}.nx-stack{gap:7px}.nx-primary{background:var(--nx-lime);border-color:var(--nx-lime);color:#10150a;font-weight:700}.nx-primary:hover{background:#dcff8c;border-color:#dcff8c}.nx-row{gap:7px}.nx-row button{font-size:9px;padding:10px 6px}.nx-separator{background:#303630;margin:21px 0 17px}.nx-section-label{font-size:8px;color:#d5dbd1;letter-spacing:.15em}.nx-section-label small{font-size:6px;color:#697267}
.nx-parts{gap:3px;margin-top:10px}.nx-parts button{padding:9px 8px;border-radius:2px;color:#a6aea2;font-size:9px;letter-spacing:.01em}.nx-parts button:hover{background:#181d18}.nx-parts button span{font-family:Consolas,monospace;color:#60695f}.nx-parts button b{font-size:6px;letter-spacing:.12em;color:#5f695c}.nx-parts button.on{background:#1a2115;color:var(--nx-lime);border-color:#495c37}
.nx-below{gap:14px;margin-top:14px;grid-template-columns:1.15fr .85fr}.nx-component,.nx-guide{position:relative;min-height:230px;border:1px solid #2e342e;background:var(--nx-panel);border-radius:4px;padding:27px}.nx-card-index{position:absolute;right:25px;top:24px;color:#626a60;font:8px Consolas,monospace;letter-spacing:.12em}.nx-component h2{font-size:29px;font-weight:300;letter-spacing:-.035em;margin:17px 0 10px}.nx-component p,.nx-guide p{font-size:10px;line-height:1.75;color:#858e83}.nx-component>button{margin-top:14px}.nx-guide>div:not(.nx-card-index):not(.nx-eyebrow){margin-top:18px}.nx-guide b{color:var(--nx-lime);font:9px Consolas,monospace}.nx-guide strong{font-size:10px;color:#e3e8df;margin-bottom:3px}.nx-temp strong{font:300 30px Consolas,monospace}.nx-temp button{width:42px}
.nx-report{border-top:1px solid var(--nx-line);padding-top:31px}.nx-section-header h2{font-size:42px;font-weight:300;letter-spacing:-.045em}.nx-empty,.nx-card,.nx-metrics>div{background:var(--nx-panel);border-color:#303630;border-radius:4px}.nx-empty{border:1px solid #303630}.nx-empty h3{font-weight:300}.nx-report-picker{color:#929a90}.nx-report-picker select{background:#0e110e;border-color:#343b34;border-radius:3px;color:#e9ede5}.nx-metrics>div{padding:20px}.nx-metrics small{color:#737c71}.nx-metrics strong{color:#edf2e8;font-weight:300}.nx-card h3{font-weight:400}.nx-card p{color:#838c81}.nx-track{background:#252c24}.nx-track i{background:var(--nx-lime)}.nx-bar b{color:var(--nx-lime)}th{color:var(--nx-lime)}th,td{border-color:#2d342c}.nx-swatch{border-radius:3px}.nx-comparison dl>div{border-color:#30372f}.nx-comparison dt{color:#899287}.nx-comparison dd{color:#ecf1e8}.nx-fine{color:#727c70!important}
.nx-modal-backdrop{background:#020402d9}.nx-modal{background:#111511;border-color:#414941;border-radius:5px}.nx-modal h2{font-weight:300}.nx-modal textarea{background:#090c09;border-color:#353d34;border-radius:3px}.nx-rating button.on{border-color:var(--nx-lime);color:var(--nx-lime);background:#1b2413}.nx-render-error{background:#271311;color:#ffb9ae;border:1px solid #71362e}
.nx-app footer{padding-top:8px;border-top:1px solid #242a24;color:#596157}.nx-vr{border-radius:0}.nx-reticle-wrap small{color:var(--nx-lime)}.nx-vr-tools button{background:#0a0d0acc}
@media(max-width:1100px){.nx-header-status{display:none}.nx-workspace{grid-template-columns:minmax(0,1fr) 315px}.nx-viewer{min-height:610px}.nx-side{padding:20px}.nx-view-toggle{top:25px;left:auto;right:25px}}
@media(max-width:820px){.nx-header{position:relative;height:auto;min-height:102px;padding:14px 20px 0;flex-wrap:wrap}.nx-header nav{order:3;width:100%;height:42px}.nx-header nav button{flex:1;padding:0 8px}.nx-app main{padding:30px 16px 20px}.nx-intro{align-items:flex-start}.nx-intro h1{font-size:42px}.nx-intro p{max-width:390px}.nx-workspace{grid-template-columns:1fr}.nx-viewer{min-height:520px}.nx-side{padding:22px}.nx-parts{display:grid;grid-template-columns:1fr 1fr}.nx-below{grid-template-columns:1fr}.nx-metrics{grid-template-columns:1fr 1fr}.nx-report-grid,.nx-comparison{grid-template-columns:1fr}}
@media(max-width:520px){.nx-brand{font-size:13px}.nx-logo{width:34px;height:34px}.nx-intro{display:block}.nx-intro h1{font-size:38px}.nx-session{display:inline-flex;margin-top:20px}.nx-viewer{min-height:470px}.nx-scene-title{left:18px;top:18px}.nx-scene-title h2{font-size:27px}.nx-view-toggle{top:18px;right:16px}.nx-view-toggle button{padding:7px 9px}.nx-scene-tools{left:16px;bottom:100px}.nx-viewer-bottom{left:18px;right:18px}.nx-speed strong{font-size:42px}.nx-target-readout span{max-width:170px}.nx-parts{grid-template-columns:1fr}.nx-component,.nx-guide{padding:24px}.nx-card-index{right:20px}.nx-app footer{flex-direction:column}.nx-section-header{align-items:flex-start}.nx-section-header h2{font-size:34px}.nx-section-header>button{font-size:8px}.nx-metrics strong{font-size:19px}}
`;
