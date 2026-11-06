// Reproducción del N4. Todo sale de v4-results.json, que escribe pipeline_v4.py.
// La web no entrena ni simula: dibuja las posiciones que Python calculó cada 0,05 s.
const $ = id => document.getElementById(id);
const signed = (n, d = 1) => `${n >= 0 ? '+' : ''}${Number(n).toFixed(d)}`;
const pct = n => `${Math.round(n * 100)}%`;
let data, scenarios = [], selected = 0, frameIndex = 0, playing = true, stepMs = 250, lastToast = -1;

const TERRAIN = { tierra: 'Tierra', lodo: 'Lodo', agua: 'Agua', pasto: 'Pasto', foso: 'Foso', rampa: 'Rampa', valla: 'Valla', puente: 'Puente', aire: 'En el aire' };
const EVENTS = {
  pisa_lodo: 'Entra al lodo: la resistencia lo frena', pisa_agua: 'Pisa agua: casi no tiene agarre', pisa_pasto: 'Se sale al pasto: frena un poco',
  derrapa_por_poco_agarre: 'Gira más de lo que permite el agarre: se va de largo', salta_la_rampa: '¡Salta la rampa!', aterriza: 'Aterriza',
  aterriza_en_el_puente: 'Aterriza sobre el puente', vuela_sobre_el_hueco: 'Vuela sobre el hueco del puente', se_sale_del_puente: 'Se sale del borde del puente',
  cae_del_puente: 'Cae del puente (más de 2 m)', cae_al_foso: 'Cae al foso', cae_en_foso: 'Accidente en el foso', choca_con_la_valla: 'Choca con la valla y frena en seco',
  frena_contra_la_valla: 'Se detiene contra la valla', sale_de_la_pista: 'Se sale de la pista', sale_volando_de_la_pista: 'Sale volando de la pista',
  aterrizaje_duro: 'Aterrizaje demasiado duro', choca_con_el_borde_del_puente: 'Choca con el borde del puente',
};
const CAUSES = { en_curso: 'EN CARRERA', vuelta_completada: 'VUELTA COMPLETA', demasiados_accidentes: 'DEMASIADOS ACCIDENTES', atascado: 'ATASCADO (10 s sin avanzar)', limite_pasos: 'LÍMITE DE TIEMPO' };
const MODES = { evaluation: 'EVALUACIÓN · política congelada en una pista que nunca vio', baseline: 'REFERENCIA · reglas escritas a mano (no aprende)', incident: 'CONDICIÓN DIFÍCIL · evaluación con una perturbación' };

function toast(text) { const el = $('eventToast'); el.textContent = text; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 1500); }

function render() {
  const sc = scenarios[selected], f = sc.frames[Math.min(frameIndex, sc.frames.length - 1)];
  $('modeBanner').dataset.mode = sc.mode; $('modeBanner').textContent = MODES[sc.mode] + (sc.ghost ? ' · coche azul translúcido: Q-learning' : '');
  $('episode').textContent = `#${sc.layout.seed - 100000 + 1}`;
  $('policyName').textContent = sc.policy;
  $('progress').firstChild.textContent = Math.round(f.progress_pct);
  $('progressBar').style.width = `${f.progress_pct}%`;
  $('distance').textContent = `${Math.round(Math.min(f.s, data.track_length))} m de ${Math.round(data.track_length)} m`;
  $('speedKmh').firstChild.textContent = Math.round(f.speed_kmh);
  $('speedMs').textContent = `${f.speed_mps.toFixed(1)} m/s`;
  const [thr, steer] = f.action ?? [0, 0];
  const bar = (el, v) => { el.style.left = v >= 0 ? '50%' : `${50 + v * 50}%`; el.style.width = `${Math.abs(v) * 50}%`; el.style.background = v >= 0 ? '#47df9a' : '#ff6b5b'; };
  bar($('throttleBar'), thr); bar($('steerBar'), steer); $('steerBar').style.background = '#ffd12e';
  $('height').textContent = `${f.z.toFixed(1)} m${f.airborne ? ' · aire' : ''}`;
  $('here').textContent = TERRAIN[f.terrain_here] ?? f.terrain_here;
  $('lane').textContent = `${f.lane + 1} / 4`;
  $('fuel').textContent = `${f.fuel_l.toFixed(1)} L`;
  $('cps').textContent = `${f.checkpoints} / ${Math.floor(data.track_length / data.config.track.checkpoint_every_m)}`;
  $('accidents').textContent = `${f.accidents} / ${data.config.episode.max_accidents}`;
  $('reward').textContent = `${signed(f.reward, 2)} (Σ ${signed(f.return)})`;
  $('time').textContent = `${(f.steps * data.config.physics.dt_s).toFixed(1)} s`;
  $('trackScore').textContent = `PUNTOS ${signed(f.return)}`;
  const said = (f.events || []).filter(e => e !== 'derrapa_por_poco_agarre' || f.speed_mps > 12).map(e => EVENTS[e] ?? e);
  $('events').textContent = said.length ? said.join(' · ') : '—';
  $('status').textContent = CAUSES[f.termination_cause] ?? f.termination_cause;
  const loud = (f.events || []).filter(e => e !== 'derrapa_por_poco_agarre' && !e.startsWith('pisa_')).map(e => EVENTS[e] ?? e);
  if (loud.length && frameIndex !== lastToast) { toast(loud[loud.length - 1]); lastToast = frameIndex; }
}

function startScenario(i) {
  selected = i; frameIndex = 0; $('replaySelect').value = String(i);
  const sc = scenarios[i];
  $('legendCars').innerHTML = `<span><b style="background:#ffc320"></b>${sc.policy}</span>` + (sc.ghost ? `<span><b style="background:#5a8ee8"></b>${sc.ghost.policy}</span>` : '');
  const detail = { layout: sc.layout, frames: sc.frames, ghost: sc.ghost, stepMs, frameIndex: 0, paused: !playing };
  window.rallyV4Scenario = detail;
  window.dispatchEvent(new CustomEvent('rally4:scenario', { detail }));
  render();
}

window.addEventListener('rally4:tick', e => {
  if (e.detail.frame !== frameIndex) { frameIndex = e.detail.frame; render(); }
  if (e.detail.end && playing) { clearTimeout(window.__loop); window.__loop = setTimeout(() => startScenario(selected), 2500); }
});

function fillTable() {
  const rows = [];
  const add = (name, cond, s, best) => rows.push({ name, cond, s, best });
  add('Azar', 'Normal', data.baselines.aleatoria);
  add('Reglas a mano', 'Normal', data.baselines.reglas);
  add('Reglas a mano', 'Lluvia', data.baselines.reglas_lluvia);
  const label = { normal: 'Normal', lluvia: 'Lluvia', sensor_ruidoso: 'Sensores con ruido' };
  for (const [algo, name] of [['qlearning', 'Q-learning (tabla)'], ['ppo', 'PPO (red neuronal)']]) {
    for (const c of ['normal', 'lluvia', 'sensor_ruidoso']) add(name, label[c], data.summary[algo][c], algo === 'ppo' && c === 'normal');
  }
  $('compareTable').tBodies[0].replaceChildren(...rows.map(r => {
    const tr = document.createElement('tr'); if (r.best) tr.className = 'best';
    const t = r.s.mean_time_s_success;
    tr.innerHTML = `<td>${r.name}</td><td>${r.cond}</td><td>${pct(r.s.success_rate)}</td><td>${signed(r.s.mean_return)}</td><td>${t ? t.toFixed(1) + ' s' : '—'}</td><td>${r.s.mean_accidents.toFixed(2)}</td><td>${Math.round(r.s.mean_progress_pct)}%</td>`;
    return tr;
  }));
  const sel = data.selection;
  $('selection').textContent = sel.accepted ? `HIPÓTESIS CONFIRMADA · PPO ${pct(sel.ppo_success_rate)} vs Q-learning ${pct(sel.qlearning_success_rate)}` : `HIPÓTESIS NO CONFIRMADA · PPO ${pct(sel.ppo_success_rate)} vs Q-learning ${pct(sel.qlearning_success_rate)}`;
  $('selection').className = sel.accepted ? 'ok' : 'bad';
  $('hypothesis').textContent = `Hipótesis (escrita antes de entrenar): ${data.config.experiment.hypothesis} Criterio: PPO ≥ ${pct(sel.criteria.min_success_rate)} y al menos ${Math.round(sel.criteria.min_success_margin_over_qlearning * 100)} puntos más que Q-learning.` +
    (data.tracking.startsWith('omitido') ? ' Nota: datos generados sin DVC ni MLflow (prueba).' : '');
}

function drawCurves() {
  const svg = $('curveChart'), NS = 'http://www.w3.org/2000/svg';
  const W = 720, H = 260, m = { l: 46, r: 16, t: 14, b: 34 };
  const runs = data.runs;
  const maxX = Math.max(...runs.flatMap(r => r.curves.evaluacion.map(p => p.timesteps)), 1);
  const x = v => m.l + (W - m.l - m.r) * v / maxX, y = v => H - m.b - (H - m.t - m.b) * v;
  const el = (t, a) => { const n = document.createElementNS(NS, t); for (const k in a) n.setAttribute(k, a[k]); svg.appendChild(n); return n; };
  svg.replaceChildren();
  for (const v of [0, 0.25, 0.5, 0.75, 1]) { el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: '#2d3a46' }); el('text', { x: 8, y: y(v) + 4 }).textContent = `${v * 100}%`; }
  for (const v of [0, 0.5, 1]) el('text', { x: x(v * maxX) - 14, y: H - 10 }).textContent = `${Math.round(v * maxX / 1000)}k`;
  const color = { ppo: '#ffc320', qlearning: '#5a8ee8' };
  for (const r of runs) {
    const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.timesteps).toFixed(1)} ${y(p.success_rate).toFixed(1)}`).join(' ');
    if (r.curves.entrenamiento.length) el('path', { d: path(r.curves.entrenamiento), fill: 'none', stroke: color[r.algorithm], 'stroke-width': 1.2, 'stroke-dasharray': '4 4', opacity: 0.6 });
    el('path', { d: path(r.curves.evaluacion), fill: 'none', stroke: color[r.algorithm], 'stroke-width': 2.2 });
  }
  el('text', { x: W - 190, y: 26, style: 'fill:#ffc320' }).textContent = '■ PPO (3 semillas)';
  el('text', { x: W - 190, y: 44, style: 'fill:#5a8ee8' }).textContent = '■ Q-learning (3 semillas)';
  el('text', { x: W - 190, y: 62 }).textContent = '— evaluación  ··· entrenamiento';
}

try {
  const res = await fetch('v4-results.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('No están las corridas v4. Ejecuta: python pipeline_v4.py');
  data = await res.json();
  window.rallyV4Data = data;
  scenarios = data.scenarios;
  const r = data.config.reward;
  $('rewardRule').textContent = `Recompensa: +${r.per_meter} por metro nuevo · +${r.checkpoint} por checkpoint · ${r.step} por paso de 0,25 s · ${r.accident} por accidente · ${r.stalled} si se atasca · +${r.finish} al terminar y +${r.remaining_fuel_per_l} por litro sobrante.`;
  const rec = data.runs.find(x => x.run_id === data.selection.recommended_run_id);
  $('modelInfo').textContent = rec ? `Modelo recomendado: PPO semilla ${rec.seed} · ${rec.run_id} · SHA-256 ${rec.model_sha256.slice(0, 12)}… · paquete publicado en modelos/n4/ppo-recomendado/ (model.zip, policy.onnx, normalization.json, manifest.json)` : '';
  $('replaySelect').replaceChildren(...scenarios.map((s, i) => new Option(s.label, String(i))));
  $('replaySelect').disabled = $('toggle').disabled = false;
  fillTable(); drawCurves();
  const params = new URLSearchParams(location.search);
  const wanted = scenarios.findIndex(s => s.id === params.get('escenario'));
  window.rallyV4Scenario = null;
  await import('./scene-v4.js');
  startScenario(wanted >= 0 ? wanted : 0);
  $('loadStatus').textContent = 'Reproducción de carreras reales calculadas por Python (física cada 0,05 s). Ninguna de estas pistas se usó para entrenar.';
  $('replaySelect').onchange = () => startScenario(Number($('replaySelect').value));
  $('toggle').onclick = () => { playing = !playing; $('toggle').textContent = playing ? 'Pausar' : 'Reanudar'; window.dispatchEvent(new CustomEvent('rally4:control', { detail: { paused: !playing } })); };
  $('reset').onclick = () => startScenario(selected);
  $('speed').onchange = () => { stepMs = Number($('speed').value); startScenario(selected); };
} catch (error) {
  console.error(error);
  $('loadStatus').textContent = error.message;
  $('sceneStatus').textContent = 'No se pudo cargar la reproducción v4.';
}
