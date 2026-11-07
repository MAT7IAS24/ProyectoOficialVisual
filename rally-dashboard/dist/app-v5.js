// Reproducción del N5. Todo sale de v5-results.json, que escribe pipeline_v5.py (y v4-results.json
// para la columna de comparación). La web no entrena ni simula: dibuja lo que Python calculó cada 0,025 s.
const $ = id => document.getElementById(id);
const signed = (n, d = 1) => `${n >= 0 ? '+' : ''}${Number(n).toFixed(d)}`;
const pct = n => (n == null ? '—' : `${Math.round(n * 100)}%`);
const deg = n => (n == null ? '—' : `${n.toFixed(1)}°`);
let data, v4 = null, scenarios = [], selected = 0, frameIndex = 0, playing = true, stepMs = 250, lastToast = -1;

const TERRAIN = { asfalto: 'Asfalto', lodo: 'Barro', agua: 'Agua', pasto: 'Pasto', foso: 'Foso', rampa: 'Rampa', valla: 'Valla', puente: 'Puente', aire: 'En el aire' };
const EVENTS = {
  pisa_lodo: 'Entra al barro: frena fuerte y los surcos lo mantienen derecho', pisa_agua: 'Pisa agua: poco agarre, puede derrapar', pisa_pasto: 'Se sale al pasto: frena un poco',
  derrapa: 'Derrapa: la carrocería apunta a un lado y el coche va hacia otro', patina_al_acelerar: 'Las ruedas patinan: pide más fuerza de la que da el agarre',
  bloquea_los_frenos: 'Bloquea los frenos: frena más de lo que permite el agarre', hace_un_trompo: '¡Trompo! (deslizó más de 70°)',
  salta_la_rampa: '¡Salta la rampa!', aterriza: 'Aterriza', aterriza_en_el_puente: 'Aterriza sobre el puente', vuela_sobre_el_hueco: 'Vuela sobre el hueco del puente',
  se_sale_del_puente: 'Se sale del borde del puente', cae_del_puente: 'Cae del puente (más de 2 m)', cae_al_foso: 'Cae al foso', cae_en_foso: 'Accidente en el foso',
  choca_con_la_valla: 'Choca con la valla y frena en seco', frena_contra_la_valla: 'Se detiene contra la valla', sale_de_la_pista: 'Se sale de la pista',
  sale_volando_de_la_pista: 'Sale volando de la pista', aterrizaje_duro: 'Aterrizaje demasiado duro', choca_con_el_borde_del_puente: 'Choca con el borde del puente',
};
const QUIET = new Set(['pisa_lodo', 'pisa_agua', 'pisa_pasto', 'derrapa', 'patina_al_acelerar', 'bloquea_los_frenos', 'aterriza']);
const CAUSES = { en_curso: 'EN CARRERA', vuelta_completada: 'VUELTA COMPLETA', demasiados_accidentes: 'DEMASIADOS ACCIDENTES', atascado: 'ATASCADO (10 s sin avanzar)', limite_pasos: 'LÍMITE DE TIEMPO' };
const MODES = {
  evaluation: 'EVALUACIÓN · política congelada en una pista que nunca vio', baseline: 'REFERENCIA · reglas escritas a mano (no aprende)',
  incident: 'CONDICIÓN DIFÍCIL · evaluación con una perturbación', compare: 'ANTES Y AHORA · misma pista, mismas reglas, física del N4 (azul) y del N5 (amarillo)',
};

function toast(text) { const el = $('eventToast'); el.textContent = text; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 1600); }

function gripHere(f, sc) {
  if (f.terrain_here === 'aire') return null;
  const base = f.terrain_here === 'puente' ? 1.0 : data.config.terrains[f.terrain_here]?.grip;
  return base == null ? null : base * (/lluvia/i.test(sc.label) ? 0.7 : 1);
}

function render() {
  const sc = scenarios[selected], f = sc.frames[Math.min(frameIndex, sc.frames.length - 1)];
  $('modeBanner').dataset.mode = sc.mode === 'compare' ? 'intervention' : sc.mode;
  $('modeBanner').textContent = MODES[sc.mode] + (sc.ghost && sc.mode !== 'compare' ? ` · coche azul translúcido: ${sc.ghost.policy}` : '');
  $('episode').textContent = `#${sc.layout.seed - 100000 + 1}`;
  $('policyName').textContent = sc.policy;
  $('progress').firstChild.textContent = Math.round(f.progress_pct);
  $('progressBar').style.width = `${f.progress_pct}%`;
  $('distance').textContent = `${Math.round(Math.min(f.s, data.track_length))} m de ${Math.round(data.track_length)} m`;
  $('speedKmh').firstChild.textContent = Math.round(f.speed_kmh);
  $('speedMs').textContent = `${f.speed_mps.toFixed(1)} m/s`;
  const [thr, steer] = f.action ?? [0, 0];
  const bar = (el, v, color) => { el.style.left = v >= 0 ? '50%' : `${50 + v * 50}%`; el.style.width = `${Math.abs(v) * 50}%`; el.style.background = color ?? (v >= 0 ? '#47df9a' : '#ff6b5b'); };
  const maxSteer = data.config.physics.max_steer_rad * 180 / Math.PI;
  bar($('throttleBar'), thr); bar($('pedalBar'), f.pedal ?? 0);
  bar($('steerBar'), steer, '#ffd12e'); bar($('steerRealBar'), (f.steer_deg ?? 0) / maxSteer);
  const grip = gripHere(f, sc);
  $('here').textContent = TERRAIN[f.terrain_here] ?? f.terrain_here;
  $('grip').textContent = grip == null ? '—' : grip.toFixed(2);
  $('steerDeg').textContent = `${(f.steer_deg ?? 0).toFixed(1)}°`;
  $('yaw').textContent = `${((f.yaw_rate ?? 0) * 180 / Math.PI).toFixed(0)}°/s`;
  $('height').textContent = `${f.z.toFixed(1)} m${f.airborne ? ' · aire' : ''}`;
  $('lane').textContent = `${f.lane + 1} / 4`;
  $('cps').textContent = `${f.checkpoints} / ${Math.floor(data.track_length / data.config.track.checkpoint_every_m)}`;
  $('accidents').textContent = `${f.accidents} / ${data.config.episode.max_accidents}`;
  $('reward').textContent = `${signed(f.reward, 2)} (Σ ${signed(f.return)})`;
  $('time').textContent = `${(f.steps * data.config.physics.dt_s).toFixed(1)} s`;
  $('trackScore').textContent = `PUNTOS ${signed(f.return)}`;
  // Indicador de deslizamiento: aguja = ángulo entre hacia dónde apunta y hacia dónde va (±30° a tope).
  const slip = f.slip_deg ?? 0, a = Math.max(-30, Math.min(30, slip)) / 30 * 80 * Math.PI / 180;
  $('slipNeedle').setAttribute('x2', (60 + 44 * Math.sin(a)).toFixed(1)); $('slipNeedle').setAttribute('y2', (60 - 44 * Math.cos(a)).toFixed(1));
  $('slipDeg').textContent = `${Math.abs(slip).toFixed(1)}°`;
  document.querySelector('.slip-gauge').classList.toggle('sliding', Math.abs(slip) > data.config.physics.slide_event_deg);
  const said = (f.events || []).map(e => EVENTS[e] ?? e);
  $('events').textContent = said.length ? said.join(' · ') : '—';
  $('status').textContent = CAUSES[f.termination_cause] ?? f.termination_cause;
  const loud = (f.events || []).filter(e => !QUIET.has(e)).map(e => EVENTS[e] ?? e);
  const soft = (f.events || []).filter(e => e === 'pisa_lodo' || e === 'derrapa').map(e => EVENTS[e]);
  if ((loud.length || soft.length) && frameIndex !== lastToast) { toast((loud.length ? loud : soft).at(-1)); lastToast = frameIndex; }
}

function startScenario(i) {
  selected = i; frameIndex = 0; $('replaySelect').value = String(i);
  const sc = scenarios[i];
  $('legendCars').innerHTML = `<span><b style="background:#ffc320"></b>${sc.policy}</span>` + (sc.ghost ? `<span><b style="background:#5a8ee8"></b>${sc.ghost.policy}</span>` : '');
  const detail = { layout: sc.layout, frames: sc.frames, ghost: sc.ghost, stepMs, frameIndex: 0, paused: !playing };
  window.rallyV5Scenario = detail;
  window.dispatchEvent(new CustomEvent('rally5:scenario', { detail }));
  render();
}

window.addEventListener('rally5:tick', e => {
  if (e.detail.frame !== frameIndex) { frameIndex = e.detail.frame; render(); }
  if (e.detail.end && playing) { clearTimeout(window.__loop); window.__loop = setTimeout(() => startScenario(selected), 2500); }
});

function fillMud() {
  const sel = data.selection, n4 = sel.n4_reference, rules = data.baselines.reglas;
  const ppo = data.summary.ppo.normal;
  const card = (label, before, after, ok, note) => `<div class="mud-card"><div class="label">${label}</div><div class="vals"><span class="before">${before}</span><span class="after${ok ? '' : ' bad'}">${after}</span></div><small>${note}</small></div>`;
  $('mudCompare').innerHTML = [
    card('Diagonal al cruzar el barro (reglas)', deg(n4.rules_mud_course_deg), deg(rules.mean_mud_course_deg), sel.checks.barro_sin_diagonal,
      `Ángulo entre hacia dónde avanza el coche y la pista. Meta: menos de ${sel.criteria.max_mean_mud_course_deg}°.`),
    card('Velocidad de lado en el barro (reglas)', `${n4.rules_mud_lateral_mps.toFixed(1)} m/s`, `${(rules.mean_mud_lateral_mps ?? 0).toFixed(1)} m/s`, sel.checks.barro_sin_diagonal,
      'Cuántos metros por segundo se corre hacia un costado mientras pisa barro.'),
    card('Vueltas completas · reglas', pct(n4.rules_success_rate), pct(rules.success_rate), sel.checks.reglas_conservan_exito,
      `Con la física nueva, las reglas deben seguir completando al menos el ${pct(sel.criteria.min_success_rate_rules)}.`),
    card('Vueltas completas · PPO', pct(n4.ppo_success_rate), pct(ppo.success_rate), sel.checks.ppo_no_empeora_vs_n4,
      `PPO aprende desde cero con la física nueva (1 M de pasos). No debe empeorar más de ${Math.round(sel.criteria.ppo_not_worse_than_n4_by * 100)} puntos.`),
  ].join('');
  $('selection').textContent = sel.accepted ? 'HIPÓTESIS CONFIRMADA' : 'HIPÓTESIS NO CONFIRMADA (ver cada criterio)';
  $('selection').className = sel.accepted ? 'ok' : 'bad';
  $('hypothesis').textContent = `Hipótesis (escrita antes de entrenar): ${data.config.experiment.hypothesis}` +
    (data.tracking.startsWith('omitido') ? ' Nota: datos generados sin DVC ni MLflow; la corrida oficial se repite con tracking.' : '');
}

function fillAttempts() {
  const sel = data.selection, prev = sel.previous_attempt;
  if (!prev) return;
  const ppo = data.summary.ppo.normal, q = data.summary.qlearning.normal;
  const box = (title, ok, okLabel, items, big) => `<div class="attempt"><h3>${title}<em class="${ok ? 'ok' : ''}">${okLabel}</em></h3><div class="big">${big}</div><ul>${items.map(i => `<li>${i}</li>`).join('')}</ul></div>`;
  $('attemptGrid').innerHTML = [
    box(`Intento 1 · ${prev.date}`, false, 'RECHAZADO', [
      `PPO ${pct(prev.ppo_success_rate)} · Q-learning ${pct(prev.qlearning_success_rate)} · reglas ${pct(prev.rules_success_rate)}`,
      `Barro ${deg(prev.rules_mud_course_deg)} (sí cumplía)`,
      ...prev.diagnosis,
    ], `PPO ${pct(prev.ppo_success_rate)}`),
    box(`Intento ${sel.attempt} · misma física y recompensa`, sel.accepted, sel.accepted ? 'ACEPTADO' : 'RECHAZADO', [
      `PPO ${pct(ppo.success_rate)} · Q-learning ${pct(q.success_rate)} · reglas ${pct(sel.rules_success_rate)}`,
      ...data.config.experiment.changes_vs_attempt_1,
    ], `PPO ${pct(ppo.success_rate)}`),
  ].join('');
  $('attemptNote').textContent = `El intento 1 sigue guardado: código en el commit ${prev.commit}, informe ${prev.report}. Solo cambió cómo aprende la IA; la pista, la física, la recompensa y las 30 pistas del examen son las mismas.`;
  $('attempts').hidden = false;
}

function fillTable() {
  const rows = [];
  const old = v4 ? { aleatoria: v4.baselines.aleatoria, reglas: v4.baselines.reglas, reglas_lluvia: v4.baselines.reglas_lluvia, ...v4.summary } : null;
  const add = (name, cond, s, n4, best) => rows.push({ name, cond, s, n4, best });
  add('Azar', 'Normal', data.baselines.aleatoria, old?.aleatoria);
  add('Reglas a mano', 'Normal', data.baselines.reglas, old?.reglas);
  add('Reglas a mano', 'Lluvia', data.baselines.reglas_lluvia, old?.reglas_lluvia);
  const label = { normal: 'Normal', lluvia: 'Lluvia', sensor_ruidoso: 'Sensores con ruido' };
  for (const [algo, name] of [['qlearning', 'Q-learning (tabla)'], ['ppo', 'PPO (red neuronal)']]) {
    for (const c of ['normal', 'lluvia', 'sensor_ruidoso']) add(name, label[c], data.summary[algo][c], old?.[algo]?.[c], algo === 'ppo' && c === 'normal');
  }
  $('compareTable').tBodies[0].replaceChildren(...rows.map(r => {
    const tr = document.createElement('tr'); if (r.best) tr.className = 'best';
    const t = r.s.mean_time_s_success;
    tr.innerHTML = `<td>${r.name}</td><td>${r.cond}</td><td>${pct(r.s.success_rate)}</td><td class="n4">${pct(r.n4?.success_rate)}</td><td>${signed(r.s.mean_return)}</td><td>${t ? t.toFixed(1) + ' s' : '—'}</td><td>${r.s.mean_accidents.toFixed(2)}</td><td>${deg(r.s.mean_mud_course_deg)}</td>`;
    return tr;
  }));
}

function fillExplainer() {
  const p = data.config.physics, t = data.config.terrains;
  const items = [
    ['Dos velocidades y un giro con inercia', `Antes el coche iba siempre hacia donde apuntaba. Ahora tiene velocidad hacia adelante y hacia el costado, y su giro tiene inercia (${p.yaw_inertia_kgm2} kg·m²): puede apuntar a un lado e ir hacia otro, como en un derrape real.`],
    ['Llantas con la "fórmula mágica"', `Cada eje empuja de lado según la fórmula de Pacejka: la fuerza crece con el deslizamiento de la llanta hasta un máximo (el agarre) y luego se satura. Es la que usan los juegos de carreras y los ingenieros.`],
    ['Círculo de agarre', 'Acelerar o frenar y girar comparten el mismo agarre. Si una llanta usa todo para acelerar, no le queda para girar: por eso frenar en plena curva puede hacer que el coche se vaya de largo.'],
    ['Volante y pedal graduales', `El volante gira como máximo ${p.steer_rate_rad_s} rad/s (${Math.round(p.steer_rate_rad_s * 57.3)}°/s) y el pedal llega a fondo en ${(1 / p.pedal_rate_per_s).toFixed(1)} s. Si se suelta el volante, vuelve al centro y el coche se endereza.`],
    ['Barro con surcos', `El barro frena (resistencia ${t.lodo.rolling} → ${(t.lodo.rolling * 9.81).toFixed(1)} m/s² por segundo) y sus surcos se oponen a moverse de lado respecto a la pista (fuerza de hasta ${t.lodo.plow} × el peso). Se pone lento, pero no se va de lado.`],
    ['Agua: ahí sí se derrapa', `El agua tiene agarre ${t.agua.grip} y no tiene surcos: si se gira fuerte encima, el coche desliza. Más de ${p.spin_deg}° de deslizamiento es un trompo y cuenta como accidente.`],
  ];
  $('explainGrid').innerHTML = items.map(([h, b]) => `<div><b>${h}</b>${b}</div>`).join('');
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
    const cp = r.chosen_checkpoint, pick = cp && cp.rule !== 'final' && r.curves.evaluacion.find(p => p.timesteps === cp.timesteps);
    if (pick) el('circle', { cx: x(pick.timesteps), cy: y(pick.success_rate), r: 5, fill: '#0d141b', stroke: color[r.algorithm], 'stroke-width': 2.5 });
  }
  if (runs.some(r => r.chosen_checkpoint && r.chosen_checkpoint.rule !== 'final')) el('text', { x: W - 190, y: 80 }).textContent = '○ punto elegido (validación)';
  el('text', { x: W - 190, y: 26, style: 'fill:#ffc320' }).textContent = '■ PPO (3 semillas)';
  el('text', { x: W - 190, y: 44, style: 'fill:#5a8ee8' }).textContent = '■ Q-learning (3 semillas)';
  el('text', { x: W - 190, y: 62 }).textContent = '— evaluación  ··· entrenamiento';
}

try {
  const res = await fetch('v5-results.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('No están las corridas v5. Ejecuta: python pipeline_v5.py');
  data = await res.json();
  try { const r4 = await fetch('v4-results.json', { cache: 'no-store' }); if (r4.ok) v4 = await r4.json(); } catch { v4 = null; }
  window.rallyV5Data = data;
  scenarios = data.scenarios;
  const r = data.config.reward;
  $('rewardRule').textContent = `Recompensa: +${r.per_meter} por metro nuevo · +${r.checkpoint} por checkpoint · ${r.step} por paso de 0,25 s · ${r.accident} por accidente (incluye trompo) · ${r.stalled} si se atasca · +${r.finish} al terminar y +${r.remaining_fuel_per_l} por litro sobrante.`;
  const rec = data.runs.find(x => x.run_id === data.selection.recommended_run_id);
  $('modelInfo').textContent = rec ? `Modelo recomendado: PPO semilla ${rec.seed} · ${rec.run_id} · SHA-256 ${rec.model_sha256.slice(0, 12)}… · paquete en modelos/n5/ppo-recomendado/ (model.zip, policy.onnx, normalization.json, manifest.json)` : '';
  $('replaySelect').replaceChildren(...scenarios.map((s, i) => new Option(s.label, String(i))));
  $('replaySelect').disabled = $('toggle').disabled = false;
  fillMud(); fillAttempts(); fillTable(); fillExplainer(); drawCurves();
  const params = new URLSearchParams(location.search);
  let wanted = scenarios.findIndex(s => s.id === params.get('escenario'));
  if (wanted < 0) wanted = scenarios.findIndex(s => s.id === 'antes-despues-0');
  window.rallyV5Scenario = null;
  await import('./scene-v5.js');
  startScenario(wanted >= 0 ? wanted : 0);
  $('loadStatus').textContent = 'Reproducción de carreras reales calculadas por Python (física cada 0,025 s). Ninguna de estas pistas se usó para entrenar.';
  $('replaySelect').onchange = () => startScenario(Number($('replaySelect').value));
  $('toggle').onclick = () => { playing = !playing; $('toggle').textContent = playing ? 'Pausar' : 'Reanudar'; window.dispatchEvent(new CustomEvent('rally5:control', { detail: { paused: !playing } })); };
  $('reset').onclick = () => startScenario(selected);
  $('speed').onchange = () => { stepMs = Number($('speed').value); startScenario(selected); };
} catch (error) {
  console.error(error);
  $('loadStatus').textContent = error.message;
  $('sceneStatus').textContent = 'No se pudo cargar la reproducción v5.';
}
