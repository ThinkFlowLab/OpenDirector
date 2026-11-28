const vertexSource = `
  attribute vec2 position;
  varying vec2 uv;
  void main() {
    uv = vec2(position.x, -position.y) * .5 + .5;
    gl_Position = vec4(position, 0., 1.);
  }`;

const fragmentSource = `
  precision highp float;
  varying vec2 uv;
  uniform float phase;

  float glow(vec2 p, vec2 center, vec2 radius) {
    vec2 d = (p - center) / radius;
    return exp(-dot(d, d));
  }

  float grain(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(.06711056, .00583715))));
  }

  float diffusion(vec2 p) {
    vec2 cell = floor(p);
    vec2 t = smoothstep(vec2(0.), vec2(1.), fract(p));
    return mix(mix(grain(cell), grain(cell + vec2(1., 0.)), t.x),
               mix(grain(cell + vec2(0., 1.)), grain(cell + 1.), t.x), t.y);
  }

  void main() {
    vec2 p = uv;
    vec2 drift = vec2(cos(phase), sin(phase));
    p.y += .11 * sin(5.8 * uv.x - 1.2 + .32 * sin(phase))
         + .045 * sin(11. * uv.x + 2. * uv.y + .7 * cos(phase))
         + .075 * (diffusion(uv * vec2(9., 4.) + .5 * drift) - .5);
    p.x += .036 * sin(6. * uv.y + phase);
    vec3 light = vec3(.042, .069, .12);
    light += glow(p, vec2(.54, .17), vec2(.76, .42)) * vec3(.059, .124, .226);
    light += glow(p, vec2(.80, .22), vec2(.43, .32)) * vec3(.072, .081, .125);
    light += glow(p, vec2(.78, -.025), vec2(.37, .135)) * vec3(.28, .28, .285);
    light += glow(p, vec2(.045, .19), vec2(.27, .19)) * vec3(.105, .057, .129);
    light += glow(p, vec2(.018, .15), vec2(.21, .065)) * vec3(.071, .049, .045);
    light += glow(p, vec2(.96, .49), vec2(.40, .24)) * vec3(.051, .063, .092);
    light += (grain(gl_FragCoord.xy) - .5) / 255.;
    gl_FragColor = vec4(light, 1.);
  }`;

function paintAmbientLight(canvas) {
  const gl = canvas.getContext("webgl", {
    alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power",
  });
  if (!gl) return;

  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const phase = gl.getUniformLocation(program, "phase");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let visible = false;
  let timer;
  let elapsed = 0;
  let previousTime;

  function draw() {
    const now = performance.now();
    if (previousTime !== undefined) elapsed += now - previousTime;
    previousTime = now;
    gl.uniform1f(phase, (elapsed / 16000) % (2 * Math.PI));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function refresh() {
    clearInterval(timer);
    previousTime = undefined;
    if (!visible || document.hidden || gl.isContextLost()) return;
    // The soft gradients can use a smaller buffer than the displayed canvas.
    const width = Math.max(1, Math.min(640, Math.ceil(canvas.clientWidth / 3)));
    const height = Math.max(1, Math.min(460, Math.ceil(canvas.clientHeight / 3)));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
    draw();
    canvas.classList.add("painted");
    if (!reducedMotion.matches) timer = setInterval(draw, 1000 / 24);
  }

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    refresh();
  }).observe(canvas);
  new ResizeObserver(refresh).observe(canvas);
  reducedMotion.addEventListener("change", refresh);
  document.addEventListener("visibilitychange", refresh);
  canvas.addEventListener("webglcontextlost", () => {
    clearInterval(timer);
    canvas.classList.remove("painted");
  });
}

paintAmbientLight(document.querySelector(".hero-light canvas"));
