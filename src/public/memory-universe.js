/* Memory Universe — 3D visualization of extracted memories */
/* Standalone module, loaded on demand by dashboard */

(function() {
  'use strict';

  var V = '0.183.2';
  var CDN = 'https://cdn.jsdelivr.net/npm/three@' + V;

  var CLASSIFICATION_COLORS = {
    0: [0.0, 0.9, 0.9],   // U — cyan
    1: [0.3, 0.5, 1.0],   // R — blue
    2: [1.0, 0.6, 0.1],   // C — amber
    3: [1.0, 0.15, 0.15], // S — red
  };

  var TYPE_EMISSIVE = {
    fact: 1.0,
    decision: 1.8,
    preference: 1.4,
    event: 2.2,
  };

  window.initMemoryUniverse = function(token) {
    // Create overlay
    var overlay = document.createElement('div');
    overlay.id = 'memory-universe-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10000;background:#000;';
    overlay.innerHTML = '<div id="mu-loading" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#0ff;font-family:monospace;font-size:18px;">Loading Memory Universe...</div>' +
      '<div id="mu-info" style="display:none;position:absolute;right:0;top:0;width:340px;height:100%;background:rgba(0,0,0,0.85);border-left:1px solid #0ff3;padding:20px;overflow-y:auto;font-family:monospace;color:#e0e0e0;font-size:13px;"></div>' +
      '<div id="mu-tooltip" style="display:none;position:absolute;pointer-events:none;background:rgba(0,10,20,0.9);border:1px solid #0ff5;padding:8px 12px;border-radius:4px;color:#e0e0e0;font-family:monospace;font-size:12px;max-width:300px;"></div>' +
      '<button id="mu-close" style="position:absolute;top:16px;left:16px;z-index:10001;background:none;border:1px solid #0ff5;color:#0ff;font-size:20px;cursor:pointer;padding:6px 14px;border-radius:4px;font-family:monospace;">✕ ESC</button>' +
      '<div id="mu-stats" style="position:absolute;bottom:16px;left:16px;color:#0ff8;font-family:monospace;font-size:12px;"></div>';
    document.body.appendChild(overlay);

    var closeBtn = document.getElementById('mu-close');
    closeBtn.onclick = destroy;
    document.addEventListener('keydown', onEsc);

    function onEsc(e) { if (e.key === 'Escape') destroy(); }
    function destroy() {
      document.removeEventListener('keydown', onEsc);
      if (animId) cancelAnimationFrame(animId);
      overlay.remove();
    }

    var animId = null;
    var memories = [], entities = [], links = [];
    var particleData = [];

    // Fetch data then load Three.js
    fetch('/api/memory/all', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        memories = data.memories || [];
        entities = data.entities || [];
        links = data.links || [];
        document.getElementById('mu-stats').textContent = memories.length + ' memories · ' + entities.length + ' entities';
        // Inject import map for Three.js ES modules
        var im = document.createElement('script');
        im.type = 'importmap';
        im.textContent = JSON.stringify({ imports: {
          "three": CDN + "/build/three.module.min.js",
          "three/addons/": CDN + "/examples/jsm/"
        }});
        document.head.appendChild(im);
        return import(CDN + "/build/three.module.min.js");
      })
      .then(function(THREE) {
        return Promise.all([
          import(CDN + "/examples/jsm/controls/OrbitControls.js"),
          import(CDN + "/examples/jsm/postprocessing/EffectComposer.js"),
          import(CDN + "/examples/jsm/postprocessing/RenderPass.js"),
          import(CDN + "/examples/jsm/postprocessing/UnrealBloomPass.js"),
        ]).then(function(mods) {
          return { THREE: THREE, OrbitControls: mods[0].OrbitControls, EffectComposer: mods[1].EffectComposer, RenderPass: mods[2].RenderPass, UnrealBloomPass: mods[3].UnrealBloomPass };
        });
      })
      .then(function(m) { buildScene(m); })
      .catch(function(err) {
        document.getElementById('mu-loading').textContent = 'Error: ' + err.message;
      });

    function buildScene(m) {
      var THREE = m.THREE;
      document.getElementById('mu-loading').style.display = 'none';

      var w = window.innerWidth, h = window.innerHeight;
      var scene = new THREE.Scene();
      scene.background = new THREE.Color(0x000008);

      var camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 1000);
      camera.position.set(0, 5, 25);

      var renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.2;
      overlay.insertBefore(renderer.domElement, overlay.firstChild);

      // Post-processing: bloom
      var composer = new m.EffectComposer(renderer);
      composer.addPass(new m.RenderPass(scene, camera));
      var bloom = new m.UnrealBloomPass(new THREE.Vector2(w, h), 0.8, 0.3, 0.6);
      composer.addPass(bloom);

      // Controls
      var controls = new m.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.3;

      // Starfield background
      var starGeo = new THREE.BufferGeometry();
      var starPos = new Float32Array(3000 * 3);
      for (var i = 0; i < 3000; i++) {
        starPos[i * 3] = (Math.random() - 0.5) * 200;
        starPos[i * 3 + 1] = (Math.random() - 0.5) * 200;
        starPos[i * 3 + 2] = (Math.random() - 0.5) * 200;
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
      var starMat = new THREE.PointsMaterial({ color: 0x334466, size: 0.15, sizeAttenuation: true });
      scene.add(new THREE.Points(starGeo, starMat));

      // Build entity clusters — assign positions
      var entityPositions = {};
      entities.forEach(function(e, i) {
        var angle = (i / Math.max(entities.length, 1)) * Math.PI * 2;
        var r = 6 + Math.random() * 4;
        entityPositions[e.id] = { x: Math.cos(angle) * r, y: (Math.random() - 0.5) * 4, z: Math.sin(angle) * r };
      });

      // Map memory→entities
      var memEntityMap = {};
      links.forEach(function(l) {
        if (!memEntityMap[l.memory_id]) memEntityMap[l.memory_id] = [];
        memEntityMap[l.memory_id].push(l.entity_id);
      });

      // Memory particles
      var count = memories.length;
      var positions = new Float32Array(count * 3);
      var colors = new Float32Array(count * 3);
      var sizes = new Float32Array(count);

      var now = Date.now();
      var oldest = memories.reduce(function(a, m) { return Math.min(a, m.created_at || now); }, now);
      var timeSpan = Math.max(now - oldest, 1);

      memories.forEach(function(mem, i) {
        var cls = mem.classification || 0;
        var c = CLASSIFICATION_COLORS[cls] || CLASSIFICATION_COLORS[0];
        var emissive = TYPE_EMISSIVE[mem.memory_type] || 1.0;

        // Position: entity cluster or random sphere
        var px, py, pz;
        var memEntities = memEntityMap[mem.id];
        if (memEntities && memEntities.length > 0) {
          var ep = entityPositions[memEntities[0]];
          if (ep) {
            px = ep.x + (Math.random() - 0.5) * 3;
            py = ep.y + (Math.random() - 0.5) * 2;
            pz = ep.z + (Math.random() - 0.5) * 3;
          }
        }
        if (px === undefined) {
          var theta = Math.random() * Math.PI * 2;
          var phi = Math.acos(2 * Math.random() - 1);
          var rad = 4 + Math.random() * 10;
          px = rad * Math.sin(phi) * Math.cos(theta);
          py = (mem.emotion_score || 0) * 0.8 + (Math.random() - 0.5) * 2;
          pz = rad * Math.sin(phi) * Math.sin(theta);
        }

        positions[i * 3] = px;
        positions[i * 3 + 1] = py;
        positions[i * 3 + 2] = pz;

        colors[i * 3] = c[0] * emissive;
        colors[i * 3 + 1] = c[1] * emissive;
        colors[i * 3 + 2] = c[2] * emissive;

        var recallSize = Math.max(0.8, Math.min(4.0, 0.8 + (mem.recall_count || 0) * 0.3));
        sizes[i] = recallSize;

        particleData.push({
          index: i,
          memory: mem,
          basePos: { x: px, y: py, z: pz },
          entities: memEntities || [],
        });
      });

      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

      var vertexShader = [
        'attribute float size;',
        'varying vec3 vColor;',
        'void main() {',
        '  vColor = color;',
        '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
        '  gl_PointSize = size * (400.0 / -mvPosition.z);',
        '  gl_Position = projectionMatrix * mvPosition;',
        '}',
      ].join('\n');

      var fragmentShader = [
        'varying vec3 vColor;',
        'void main() {',
        '  float d = length(gl_PointCoord - vec2(0.5));',
        '  if (d > 0.5) discard;',
        '  float glow = exp(-d * 4.0);',
        '  gl_FragColor = vec4(vColor * glow, glow);',
        '}',
      ].join('\n');

      var mat = new THREE.ShaderMaterial({
        vertexShader: vertexShader,
        fragmentShader: fragmentShader,
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });

      var points = new THREE.Points(geo, mat);
      scene.add(points);

      // Entity connection lines
      var lineMat = new THREE.LineBasicMaterial({ color: 0x0066aa, transparent: true, opacity: 0.08 });
      links.forEach(function(l) {
        var mems = particleData.filter(function(p) { return p.entities.indexOf(l.entity_id) >= 0; });
        for (var a = 0; a < mems.length; a++) {
          for (var b = a + 1; b < mems.length && b < a + 3; b++) {
            var lineGeo = new THREE.BufferGeometry().setFromPoints([
              new THREE.Vector3(mems[a].basePos.x, mems[a].basePos.y, mems[a].basePos.z),
              new THREE.Vector3(mems[b].basePos.x, mems[b].basePos.y, mems[b].basePos.z),
            ]);
            scene.add(new THREE.Line(lineGeo, lineMat));
          }
        }
      });

      // Raycaster for interaction
      var raycaster = new THREE.Raycaster();
      raycaster.params.Points.threshold = 0.5;
      var mouse = new THREE.Vector2();
      var tooltip = document.getElementById('mu-tooltip');
      var infoPanel = document.getElementById('mu-info');
      var hoveredIdx = -1;

      renderer.domElement.addEventListener('mousemove', function(e) {
        mouse.x = (e.clientX / w) * 2 - 1;
        mouse.y = -(e.clientY / h) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        var intersects = raycaster.intersectObject(points);
        if (intersects.length > 0) {
          var idx = intersects[0].index;
          if (idx !== hoveredIdx && idx < particleData.length) {
            hoveredIdx = idx;
            var mem = particleData[idx].memory;
            tooltip.style.display = 'block';
            tooltip.style.left = (e.clientX + 16) + 'px';
            tooltip.style.top = (e.clientY - 10) + 'px';
            tooltip.textContent = mem.content_en ? mem.content_en.substring(0, 120) + (mem.content_en.length > 120 ? '...' : '') : '(empty)';
          }
        } else {
          hoveredIdx = -1;
          tooltip.style.display = 'none';
        }
      });

      renderer.domElement.addEventListener('click', function(e) {
        raycaster.setFromCamera(mouse, camera);
        var intersects = raycaster.intersectObject(points);
        if (intersects.length > 0 && intersects[0].index < particleData.length) {
          var mem = particleData[intersects[0].index].memory;
          var entNames = particleData[intersects[0].index].entities.map(function(eid) {
            var ent = entities.find(function(e) { return e.id === eid; });
            return ent ? ent.name : '?';
          });
          var clsLabel = ['UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET'][mem.classification || 0] || '?';
          var clsColor = ['#0ff', '#66f', '#fa0', '#f22'][mem.classification || 0] || '#fff';
          infoPanel.style.display = 'block';
          infoPanel.innerHTML =
            '<div style="margin-bottom:16px;"><button onclick="document.getElementById(\'mu-info\').style.display=\'none\'" style="background:none;border:1px solid #0ff5;color:#0ff;cursor:pointer;padding:4px 10px;border-radius:3px;">✕</button></div>' +
            '<div style="color:#0ff;font-size:11px;margin-bottom:8px;">MEMORY #' + mem.id + '</div>' +
            '<div style="margin-bottom:12px;line-height:1.5;">' + escHtml(mem.content_en || '') + '</div>' +
            (mem.content_original && mem.content_original !== mem.content_en ? '<div style="color:#888;font-size:11px;margin-bottom:12px;">' + escHtml(mem.content_original) + '</div>' : '') +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px;">' +
            '<div>Type: <span style="color:#0ff;">' + (mem.memory_type || '?') + '</span></div>' +
            '<div>Classification: <span style="color:' + clsColor + ';">' + clsLabel + '</span></div>' +
            '<div>Emotion: <span style="color:' + (mem.emotion_score > 0 ? '#4f4' : mem.emotion_score < 0 ? '#f44' : '#888') + ';">' + (mem.emotion_score || 0) + '</span></div>' +
            '<div>Recall: <span style="color:#0ff;">' + (mem.recall_count || 0) + '</span></div>' +
            '<div>Trust: ' + (mem.trust ?? '?') + '</div>' +
            '<div>Integrity: ' + (mem.integrity ?? '?') + '</div>' +
            '<div>Credibility: ' + (mem.credibility ?? '?') + '</div>' +
            '<div>Relevance: ' + (mem.relevance_score || 0) + '</div>' +
            '</div>' +
            (entNames.length > 0 ? '<div style="margin-top:12px;color:#0ff8;font-size:11px;">Entities: ' + entNames.join(', ') + '</div>' : '') +
            '<div style="margin-top:12px;color:#666;font-size:10px;">Created: ' + new Date(mem.created_at).toLocaleString() + '</div>';
        }
      });

      // Animation
      var clock = new THREE.Clock();
      function animate() {
        animId = requestAnimationFrame(animate);
        var t = clock.getElapsedTime();
        var posAttr = geo.attributes.position;

        for (var i = 0; i < particleData.length; i++) {
          var p = particleData[i];
          var drift = 0.15;
          posAttr.array[i * 3] = p.basePos.x + Math.sin(t * 0.3 + i * 0.7) * drift;
          posAttr.array[i * 3 + 1] = p.basePos.y + Math.cos(t * 0.2 + i * 1.1) * drift;
          posAttr.array[i * 3 + 2] = p.basePos.z + Math.sin(t * 0.25 + i * 0.5) * drift;
        }
        posAttr.needsUpdate = true;

        controls.update();
        composer.render();
      }
      animate();

      // Resize
      window.addEventListener('resize', function() {
        w = window.innerWidth; h = window.innerHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        composer.setSize(w, h);
      });
    }

    function escHtml(s) {
      var d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }
  };
})();
