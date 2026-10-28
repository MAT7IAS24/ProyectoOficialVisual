const $ = (id) => document.getElementById(id);
const q = Array.from({ length: 11 }, () => [0, 0]);
let episode = 1, step = 0, position = 0, total = 0, running = true, timer;
const maxEpisodes = 25, alpha = .25, gamma = .95;
const fmt = (n, d = 1) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}`;

function render(action = '—', reward = 0, status = 'EN CARRERA', decisionState = Math.floor(position / 100)) {
  const pct = position / 10;
  $('episode').textContent = episode; $('step').firstChild.textContent = `${step} `;
  $('progress').firstChild.textContent = Math.round(pct); $('distance').textContent = `${position} m de 1000 m`;
  $('progressBar').style.width = `${pct}%`; $('action').textContent = action;
  $('reward').textContent = fmt(reward); $('return').textContent = fmt(total);
  $('trackScore').textContent = `PUNTOS ${fmt(total)}`; $('status').textContent = status;
  $('stateLabel').textContent = `TRAMO ${decisionState}`;
  $('qWait').textContent = fmt(q[decisionState][0], 3); $('qDrive').textContent = fmt(q[decisionState][1], 3);
  $('qValue').textContent = fmt(Math.max(...q[decisionState]), 3);
  // Cada posición se proyecta sobre la línea central cerrada: no existe un
  // trayecto por el interior del óvalo ni atajos hacia la meta.
  const route = $('racingLine'), length = route.getTotalLength();
  const at = route.getPointAtLength(length * position / 1000);
  const ahead = route.getPointAtLength(Math.min(length, length * position / 1000 + 1));
  const heading = Math.atan2(ahead.y - at.y, ahead.x - at.x) * 180 / Math.PI + 90;
  $('car').setAttribute('transform', `translate(${at.x} ${at.y}) rotate(${heading})`);
  // El renderizador solo recibe una copia del estado; no modifica el agente.
  window.rallyVisualState = { position, episode, step, duration: Number($('speed').value) };
  window.dispatchEvent(new CustomEvent('rally:frame', { detail: window.rallyVisualState }));
}
function tick() {
  if (!running) return;
  const state = Math.floor(position / 100);
  const epsilon = Math.max(.05, 1 - (episode - 1) / (maxEpisodes - 1) * .95);
  const actionIndex = Math.random() < epsilon ? Math.floor(Math.random() * 2) : (q[state][1] > q[state][0] ? 1 : 0);
  const action = actionIndex ? 'ACELERAR' : 'REVERSA';
  step++; position = Math.max(0, Math.min(1000, position + (actionIndex ? 100 : -100)));
  const done = position === 1000, truncated = step === 50;
  const reward = done ? 10 : -1; total += reward;
  const nextState = Math.floor(position / 100);
  const target = (done || truncated) ? reward : reward + gamma * Math.max(...q[nextState]);
  q[state][actionIndex] += alpha * (target - q[state][actionIndex]);
  render(action, reward, done ? 'META ALCANZADA' : truncated ? 'TRUNCADO · 50 PASOS' : 'EN CARRERA', state);
  if (done || truncated) setTimeout(nextEpisode, Number($('speed').value) * 1.5); else schedule();
}
function schedule(){ clearTimeout(timer); timer = setTimeout(tick, Number($('speed').value)); }
function nextEpisode(){ if (!running) return; if (episode >= maxEpisodes) { running=false; $('status').textContent='ENTRENAMIENTO COMPLETO'; $('toggle').textContent='Reiniciar entrenamiento'; return; } episode++; step=0; position=0; total=0; render(); schedule(); }
function reset(){ episode=1; step=0; position=0; total=0; q.forEach(row=>row.fill(0)); running=true; $('toggle').textContent='Pausar simulación'; render(); schedule(); }
$('toggle').onclick=()=>{ if ($('status').textContent==='ENTRENAMIENTO COMPLETO') return reset(); running=!running; $('toggle').textContent=running?'Pausar simulación':'Reanudar simulación'; if(running) schedule(); };
$('reset').onclick=reset; $('speed').oninput=()=>{ if(running) schedule(); }; render(); schedule();
