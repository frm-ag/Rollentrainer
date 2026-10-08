/* Rolle – Comic-Welt: baut aus der Route eine kleine 3D-Welt (Strasse, Hügel, Bäume, Fahrerfigur).
   Gebaut wird immer nur ein Fenster um den Fahrer (ca. 0.6 km zurück, 3 km voraus) – so läuft es auch bei sehr langen Routen flüssig. */
'use strict';
window.World = (() => {
  let T = null, renderer = null, scene = null, camera = null, rt = null, canvas = null, getState = null;
  let raf = 0, lastT = 0, chunk = null, built = {from:-1, to:-1}, origin = null, avatar = null, ground = null;
  let clouds = null, crank = 0, wheelRot = 0, camPos = null, camLook = null, heading = null;
  const AHEAD = 2600, BEHIND = 500, STEP = 5, HALF = 650, COLS = 22;

  function loadThree(){ return window.THREE ? Promise.resolve(window.THREE) : import('./three.module.min.js').then(m => (window.THREE = m)); }

  /* --- Projektion: Grad -> Meter (lokal), Rauschen für Hügel --- */
  let lat0 = 0, lon0 = 0, kx = 1;
  const proj = (lat, lon) => ({x:(lon - lon0)*kx, z:-(lat - lat0)*110540});
  const hash = (x, y) => { const s = Math.sin(x*127.1 + y*311.7)*43758.5453; return s - Math.floor(s); };
  function vnoise(x, y){
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf*xf*(3 - 2*xf), v = yf*yf*(3 - 2*yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a)*u + (c - a)*v + (a - b - c + d)*u*v;
  }
  const fbm = (x, y) => vnoise(x, y)*0.6 + vnoise(x*2.1, y*2.1)*0.28 + vnoise(x*4.3, y*4.3)*0.12;

  /* Strassenpunkt bei Distanz d (globale Koordinaten in Metern) */
  function roadAt(d){
    const p = routeAt(rt, d), q = proj(p.lat, p.lon);
    const a = routeAt(rt, Math.max(0, d - 12)), b = routeAt(rt, Math.min(rt.dist, d + 12));
    const pa = proj(a.lat, a.lon), pb = proj(b.lat, b.lon);
    let dx = pb.x - pa.x, dz = pb.z - pa.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    return {x:q.x, z:q.z, y:p.ele, dx, dz};
  }
  function terrainH(gx, gz, roadY, off){
    const a = Math.abs(off);
    if (a < 5) return roadY - 0.03;
    const t = Math.min(1, (a - 5)/35), s = t*t*(3 - 2*t);
    const n = fbm(gx/180, gz/180), n2 = fbm(gx/45 + 7, gz/45 + 3);
    const h = roadY + s*((n - 0.35)*Math.min(70, a*0.45) + (n2 - 0.5)*4);
    const e = Math.max(0, Math.min(1, (a - HALF*0.7)/(HALF*0.3)));   // am Rand sanft auslaufen
    return h + (roadY - 6 - h)*e*e;
  }

  /* --- Fenster um den Fahrer bauen --- */
  function disposeChunk(){
    if (!chunk) return;
    scene.remove(chunk);
    chunk.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    chunk = null;
  }
  function build(dCenter){
    disposeChunk();
    const from = Math.max(0, dCenter - BEHIND), to = Math.min(rt.dist, dCenter + AHEAD);
    built = {from, to};
    const o = roadAt(dCenter); origin = {x:o.x, y:o.y, z:o.z};
    chunk = new T.Group();
    const rows = []; for (let d = from; d <= to + 0.01; d += STEP) rows.push(roadAt(d));
    if (rows.length < 2) return;
    // Gelände-Band links/rechts der Strasse
    const offs = []; for (let i = 0; i <= COLS; i++){ const u = i/COLS*2 - 1; offs.push(Math.sign(u)*Math.pow(Math.abs(u), 1.8)*HALF); }
    const pos = [], col = [], idx = [], C = offs.length;
    const cGrass = new T.Color(), tmp = new T.Color();
    rows.forEach(r => {
      const nx = -r.dz, nz = r.dx;
      offs.forEach(off => {
        const gx = r.x + nx*off, gz = r.z + nz*off, h = terrainH(gx, gz, r.y, off);
        pos.push(gx - origin.x, h - origin.y, gz - origin.z);
        const n = vnoise(gx/30, gz/30), rel = h - r.y;
        if (Math.abs(off) < 5) cGrass.setRGB(0.36, 0.33, 0.27);
        else if (rel > 38) cGrass.setRGB(0.93, 0.95, 0.98);                       // Schnee
        else if (rel > 24) cGrass.setRGB(0.55, 0.53, 0.5);                        // Fels
        else { cGrass.setRGB(0.33 + n*0.12, 0.62 + n*0.12, 0.26); tmp.setRGB(0.55, 0.7, 0.3); cGrass.lerp(tmp, Math.max(0, Math.min(1, (rel - 8)/20))*0.4); }
        col.push(cGrass.r, cGrass.g, cGrass.b);
      });
    });
    for (let i = 0; i < rows.length - 1; i++) for (let j = 0; j < C - 1; j++){
      const a = i*C + j, b = a + 1, c = a + C, d = c + 1; idx.push(a, c, b, b, c, d);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    g.setIndex(idx); g.computeVertexNormals();
    chunk.add(new T.Mesh(g, new T.MeshLambertMaterial({vertexColors:true, flatShading:true})));
    // Strasse, Randlinien, Mittellinie
    const ribbon = (w0, w1, lift, color, dash) => {
      const p = [], ix = []; let n = 0;
      rows.forEach((r, i) => {
        if (dash && (Math.floor((from + i*STEP)/10) % 2)) return;
        const nx = -r.dz, nz = r.dx;
        p.push(r.x + nx*w0 - origin.x, r.y + lift - origin.y, r.z + nz*w0 - origin.z, r.x + nx*w1 - origin.x, r.y + lift - origin.y, r.z + nz*w1 - origin.z);
        if (n > 0 && (!dash || true)) ix.push((n-1)*2, n*2, (n-1)*2 + 1, (n-1)*2 + 1, n*2, n*2 + 1);
        n++;
      });
      const gg = new T.BufferGeometry(); gg.setAttribute('position', new T.Float32BufferAttribute(p, 3)); gg.setIndex(ix); gg.computeVertexNormals();
      const m = new T.Mesh(gg, new T.MeshLambertMaterial({color, side:T.DoubleSide})); chunk.add(m);
    };
    ribbon(-3.2, 3.2, 0.06, 0x50555e);
    ribbon(-3.05, -2.85, 0.09, 0xf2f2f2); ribbon(2.85, 3.05, 0.09, 0xf2f2f2);
    // Mittellinie gestrichelt: einzelne Stücke
    for (let i = 0; i < rows.length - 2; i += 4){
      const a = rows[i], b = rows[i + 1];
      const p = [], nx = -a.dz, nz = a.dx, w = 0.08;
      [[a, 1], [b, 1]].forEach(([r]) => { p.push(r.x - nx*w - origin.x, r.y + 0.1 - origin.y, r.z - nz*w - origin.z, r.x + nx*w - origin.x, r.y + 0.1 - origin.y, r.z + nz*w - origin.z); });
      const gg = new T.BufferGeometry(); gg.setAttribute('position', new T.Float32BufferAttribute(p, 3)); gg.setIndex([0, 2, 1, 1, 2, 3]); gg.computeVertexNormals();
      chunk.add(new T.Mesh(gg, dashMat));
    }
    // Bäume (instanziert)
    const trees = [];
    for (let i = 0; i < rows.length; i += 2){
      const r = rows[i], nx = -r.dz, nz = r.dx;
      for (let k = 0; k < 4; k++){
        const hsh = hash(Math.round(r.x*0.3) + k*17, Math.round(r.z*0.3) - k*13);
        if (hsh > 0.6) continue;
        const side = hash(r.x + k, r.z) > 0.5 ? 1 : -1, off = side*(8 + Math.pow(hash(r.z + k*3, r.x), 1.6)*160);
        const gx = r.x + nx*off, gz = r.z + nz*off, h = terrainH(gx, gz, r.y, off);
        if (h - r.y > 26) continue;
        if (vnoise(gx/90, gz/90) < 0.3) continue;           // Waldstücke statt gleichmässig
        trees.push([gx - origin.x, h - origin.y, gz - origin.z, 0.7 + hash(gx, gz)*0.8]);
        if (trees.length > 1400) break;
      }
    }
    if (trees.length){
      const crown = new T.InstancedMesh(treeGeo.crown, treeMat.crown, trees.length), trunk = new T.InstancedMesh(treeGeo.trunk, treeMat.trunk, trees.length);
      const m = new T.Matrix4(), q = new T.Quaternion(), sc = new T.Vector3(), ps = new T.Vector3();
      trees.forEach((t, i) => { sc.set(t[3], t[3], t[3]); ps.set(t[0], t[1], t[2]); m.compose(ps, q, sc); crown.setMatrixAt(i, m); trunk.setMatrixAt(i, m); });
      chunk.add(crown); chunk.add(trunk);
    }
    // Start- und Zielbogen
    const arch = (d, label) => {
      if (d < from || d > to) return;
      const r = roadAt(d), grp = new T.Group(), nx = -r.dz, nz = r.dx;
      [-4.2, 4.2].forEach(s => { const m = new T.Mesh(new T.BoxGeometry(0.4, 5, 0.4), archMat); m.position.set(nx*s, 2.5, nz*s); grp.add(m); });
      const top = new T.Mesh(new T.BoxGeometry(9, 1.2, 0.4), bannerMat(label)); top.position.set(0, 5, 0); top.rotation.y = Math.atan2(r.dx, r.dz); grp.add(top);
      grp.position.set(r.x - origin.x, r.y - origin.y, r.z - origin.z); chunk.add(grp);
    };
    arch(Math.min(rt.dist, 15), 'START'); arch(Math.max(0, rt.dist - 5), 'ZIEL');
    scene.add(chunk);
  }
  let dashMat, archMat, treeGeo, treeMat;
  const bannerCache = {};
  function bannerMat(text){
    if (bannerCache[text]) return bannerCache[text];
    const c = document.createElement('canvas'); c.width = 512; c.height = 72; const g = c.getContext('2d');
    g.fillStyle = '#ff6a1a'; g.fillRect(0, 0, 512, 72); g.fillStyle = '#fff'; g.font = 'bold 52px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 256, 38);
    const tx = new T.CanvasTexture(c); tx.colorSpace = T.SRGBColorSpace;
    return (bannerCache[text] = new T.MeshLambertMaterial({map:tx}));
  }

  /* --- Fahrerfigur --- */
  function makeAvatar(){
    const g = new T.Group(), M = c => new T.MeshLambertMaterial({color:c, flatShading:true});
    const jersey = M(0xff6a1a), shorts = M(0x1d2230), skin = M(0xf0c8a0), frame = M(0x2b6cff), tyre = M(0x15171c), helmet = M(0xffffff);
    const wheelGeo = new T.TorusGeometry(0.33, 0.035, 8, 28);
    const wF = new T.Mesh(wheelGeo, tyre), wB = new T.Mesh(wheelGeo, tyre);
    wF.rotation.y = Math.PI/2; wB.rotation.y = Math.PI/2; wF.position.set(0, 0.34, 0.52); wB.position.set(0, 0.34, -0.5);
    const spokes = new T.Group(); [wF, wB].forEach(w => { const s = new T.Mesh(new T.BoxGeometry(0.01, 0.62, 0.02), tyre); s.rotation.y = Math.PI/2; w.add(s); const s2 = s.clone(); s2.rotation.z = Math.PI/2; s2.rotation.y = 0; w.add(s2); });
    g.add(wF, wB);
    const limb = (mat, r) => { const m = new T.Mesh(new T.CylinderGeometry(r, r, 1, 8), mat); g.add(m); return m; };
    const place = (m, a, b) => { const d = new T.Vector3().subVectors(b, a), L = d.length(); m.position.copy(a).addScaledVector(d, 0.5); m.scale.set(1, L, 1); m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d.normalize()); };
    const V = (x, y, z) => new T.Vector3(x, y, z);
    const BB = V(0, 0.3, 0), seat = V(0, 0.92, -0.18), head = V(0, 0.9, 0.42), fr = V(0, 0.34, 0.52), rr = V(0, 0.34, -0.5);
    [[seat, BB], [BB, head], [seat, head], [head, fr], [BB, rr], [seat, rr]].forEach(([a, b]) => place(limb(frame, 0.022), a, b));
    place(limb(frame, 0.02), V(-0.2, 0.98, 0.45), V(0.2, 0.98, 0.45));          // Lenker
    const hip = V(0, 0.98, -0.15), shoulder = V(0, 1.33, 0.25);
    place(limb(jersey, 0.13), hip, shoulder);
    const helm = new T.Mesh(new T.SphereGeometry(0.13, 12, 8), helmet); helm.position.set(0, 1.47, 0.36); helm.scale.set(1, 0.85, 1.25); g.add(helm);
    const face = new T.Mesh(new T.SphereGeometry(0.1, 10, 8), skin); face.position.set(0, 1.42, 0.4); g.add(face);
    [-1, 1].forEach(s => { const sh = V(s*0.17, 1.3, 0.24); place(limb(jersey, 0.045), sh, V(s*0.18, 1.12, 0.36)); place(limb(skin, 0.035), V(s*0.18, 1.12, 0.36), V(s*0.19, 0.99, 0.45)); });
    const legs = [-1, 1].map(s => ({s, thigh:limb(shorts, 0.065), shin:limb(skin, 0.045), foot:limb(tyre, 0.04)}));
    g.userData = {wF, wB, legs, place, V, hip};
    return g;
  }
  function poseLegs(a){
    const {legs, place, V} = avatar.userData;
    legs.forEach((L, i) => {
      const ang = a + i*Math.PI, hip = V(L.s*0.1, 0.98, -0.15);
      const pedal = V(L.s*0.12, 0.3 - Math.cos(ang)*0.17, Math.sin(ang)*0.17);
      const d = new T.Vector3().subVectors(pedal, hip), dist = Math.min(0.88, d.length()), l1 = 0.46, l2 = 0.44;
      const cosA = (l1*l1 + dist*dist - l2*l2)/(2*l1*dist), A = Math.acos(Math.max(-1, Math.min(1, cosA)));
      const base = Math.atan2(d.z, -d.y) + A;                     // Knie nach vorne
      const knee = V(L.s*0.11, hip.y - Math.cos(base)*l1, hip.z + Math.sin(base)*l1);
      place(L.thigh, hip, knee); place(L.shin, knee, pedal); place(L.foot, pedal, V(pedal.x, pedal.y - 0.02, pedal.z + 0.12));
    });
  }

  /* --- Start / Stopp --- */
  async function start(route, cv, stateFn){
    stop();
    try { T = await loadThree(); } catch(e){ return false; }
    rt = route; canvas = cv; getState = stateFn;
    const p0 = rt.pts[0]; lat0 = p0[0]; lon0 = p0[1]; kx = 111320*Math.cos(lat0*Math.PI/180);
    try {
      if (!renderer || renderer.domElement !== canvas){ renderer = new T.WebGLRenderer({canvas, antialias:true, powerPreference:'high-performance'}); }
    } catch(e){ return false; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = T.SRGBColorSpace;
    scene = new T.Scene();
    const sky = new T.Color(0x8ec5f0); scene.background = sky; scene.fog = new T.Fog(0xcfe4f5, 180, 950);
    scene.add(new T.HemisphereLight(0xdff0ff, 0x4a6b3a, 1.1));
    const sun = new T.DirectionalLight(0xfff2dd, 1.6); sun.position.set(-300, 500, 200); scene.add(sun);
    camera = new T.PerspectiveCamera(56, 1, 0.3, 4000);
    dashMat = new T.MeshLambertMaterial({color:0xffffff}); archMat = new T.MeshLambertMaterial({color:0x22262e});
    treeGeo = {crown:new T.ConeGeometry(2.2, 6, 7).translate(0, 5, 0), trunk:new T.CylinderGeometry(0.3, 0.4, 2.2, 6).translate(0, 1.1, 0)};
    treeMat = {crown:new T.MeshLambertMaterial({color:0x2f7d3b, flatShading:true}), trunk:new T.MeshLambertMaterial({color:0x6b4a2b, flatShading:true})};
    ground = new T.Mesh(new T.PlaneGeometry(8000, 8000), new T.MeshLambertMaterial({color:0x4f8a3a})); ground.rotation.x = -Math.PI/2; scene.add(ground);
    avatar = makeAvatar(); scene.add(avatar);
    clouds = new T.Group(); const cm = new T.MeshLambertMaterial({color:0xffffff, emissive:0x8a8f99, flatShading:true, fog:false});
    for (let i = 0; i < 14; i++){
      const c = new T.Group(), a = i/14*Math.PI*2 + Math.random()*0.3, R = 700 + Math.random()*500;
      for (let j = 0; j < 4; j++){ const m = new T.Mesh(new T.IcosahedronGeometry(30 + Math.random()*25, 0), cm); m.position.set(j*35 - 50, Math.random()*12, Math.random()*20); m.scale.y = 0.6; c.add(m); }
      c.position.set(Math.cos(a)*R, 220 + Math.random()*120, Math.sin(a)*R); c.lookAt(0, c.position.y, 0); clouds.add(c);
    }
    scene.add(clouds);
    built = {from:-1, to:-1}; heading = null; camPos = null; camLook = null;
    const st = getState(); build(st.d);
    lastT = performance.now(); raf = requestAnimationFrame(frame);
    return true;
  }
  function stop(){
    if (raf) cancelAnimationFrame(raf); raf = 0;
    if (scene){ disposeChunk(); scene.traverse(o => { if (o.geometry) o.geometry.dispose(); }); scene = null; }
  }
  function resize(){
    if (!renderer || !canvas) return;
    const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
    const c = renderer.domElement; if (c.width !== Math.round(w*renderer.getPixelRatio()) || c.height !== Math.round(h*renderer.getPixelRatio())){ renderer.setSize(w, h, false); camera.aspect = w/h; camera.updateProjectionMatrix(); }
  }
  function frame(now){
    raf = requestAnimationFrame(frame);
    const st = getState(); if (!st){ stop(); return; }
    if (!st.visible) { lastT = now; return; }
    const dt = Math.min(0.1, (now - lastT)/1000); lastT = now;
    const d = st.d;
    if (d > built.to - 1200 && built.to < rt.dist || d < built.from + 100 && built.from > 0) build(d);
    const r = roadAt(d), next = roadAt(Math.min(rt.dist, d + 3)), prev = roadAt(Math.max(0, d - 3));
    const pos = new T.Vector3(r.x - origin.x, r.y - origin.y, r.z - origin.z);
    const tgtHead = Math.atan2(r.dx, r.dz);
    if (heading == null) heading = tgtHead;
    let dh = ((tgtHead - heading + Math.PI*3) % (Math.PI*2)) - Math.PI; heading += dh*(1 - Math.exp(-dt/0.35));
    const slope = Math.atan2(next.y - prev.y, 6);
    avatar.position.copy(pos); avatar.rotation.set(0, 0, 0); avatar.rotateY(heading); avatar.rotateX(-slope);
    // Pedalieren und Räder
    const cad = st.cad > 0 ? st.cad : (st.v > 0.5 ? 85 : 0);
    crank += cad/60*Math.PI*2*dt; wheelRot += st.v/0.34*dt;
    avatar.userData.wF.rotation.x = wheelRot; avatar.userData.wB.rotation.x = wheelRot;
    poseLegs(crank);
    // Kamera schräg hinter dem Fahrer
    const fx = Math.sin(heading), fz = Math.cos(heading);
    const want = new T.Vector3(pos.x - fx*4.6, pos.y + 2.1 + Math.max(0, -slope*3), pos.z - fz*4.6);
    const look = new T.Vector3(pos.x + fx*7, pos.y + 1.0 + slope*5, pos.z + fz*7);
    if (!camPos){ camPos = want.clone(); camLook = look.clone(); }
    // Position direkt (Glättung kommt über die Blickrichtung), nur die Höhe sanft nachführen
    const k = 1 - Math.exp(-dt/0.4); camPos.set(want.x, camPos.y + (want.y - camPos.y)*k, want.z); camLook.set(look.x, camLook.y + (look.y - camLook.y)*k, look.z);
    // Kamera nie unter dem Gelände
    camera.position.copy(camPos); camera.lookAt(camLook);
    ground.position.set(pos.x, pos.y - 7, pos.z); clouds.position.set(pos.x, pos.y, pos.z);
    resize(); renderer.render(scene, camera);
  }
  return {start, stop, resize, active:() => !!raf};
})();
