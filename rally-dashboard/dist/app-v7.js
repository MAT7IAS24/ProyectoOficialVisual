// Reproducción del N7. Todo sale de v7-results.json, que escribe pipeline_v7.py (y v6-results.json
// para la columna de comparación). La web no entrena ni simula: dibuja lo que Python calculó cada 0,025 s.
const $ = id => document.getElementById(id);
const signed = (n, d = 1) => `${n >= 0 ? '+' : ''}${Number(n).toFixed(d)}`;
const pct = n => (n == null ? '—' : `${Math.round(n * 100)}%`);
const deg = n => (n == null ? '—' : `${n.toFixed(1)}°`);
let data, v6 = null, scenarios = [], selected = 0, frameIndex = 0, playing = true, stepMs = 250, lastToast = -1;

const TERRAIN = { asfalto: 'Asfalto', lodo: 'Barro', agua: 'Agua', pasto: 'Pasto', foso: 'Foso', rampa: 'Rampa', valla: 'Valla', puente: 'Puente', aire: 'En el aire' };
const EVENTS = {
  pisa_lodo: 'Entra al barro: frena fuerte y los surcos lo mantienen derecho', pisa_agua: 'Pisa agua: poco agarre, puede derrapar', pisa_pasto: 'Se sale al pasto: frena un poco',
  derrapa: 'Derrapa: la carrocería apunta a un lado y el coche va hacia otro', patina_al_acelerar: 'Las ruedas patinan: pide más fuerza de la que da el agarre',
  bloquea_los_frenos: 'Bloquea los frenos: frena más de lo que permite el agarre', hace_un_trompo: '¡Trompo! (deslizó más de 70°)',
  salta_la_rampa: '¡Salta la rampa!', aterriza: 'Aterriza', aterriza_en_el_puente: 'Aterriza sobre el puente', vuela_sobre_el_hueco: 'Vuela sobre el hueco del puente',
  se_sale_del_puente: 'Se sale del borde del puente', cae_del_puente: 'Cae del puente (más de 2 m)', cae_al_foso: 'Cae al foso', cae_en_foso: 'Accidente en el foso',
  choca_con_la_valla: 'Choca con la valla y frena en seco', frena_contra_la_valla: 'Se detiene contra la valla', sale_de_la_pista: 'Se sale de la pista',
  sale_volando_de_la_pista: 'Sale volando de la pista', aterrizaje_duro: 'Aterrizaje demasiado duro', choca_con_el_borde_del_puente: 'Choca con el borde del puente',
  levanta_una_rueda: 'Levanta una rueda: todo el peso se fue a las de afuera', golpea_los_topes: 'Golpea los topes: la suspensión se comprimió hasta el fondo',
};
const QUIET = new Set(['pisa_lodo', 'pisa_agua', 'pisa_pasto', 'derrapa', 'patina_al_acelerar', 'bloquea_los_frenos', 'aterriza', 'levanta_una_rueda']);
const CAUSES = { en_curso: 'EN CARRERA', vuelta_completada: 'VUELTA COMPLETA', demasiados_accidentes: 'DEMASIADOS ACCIDENTES', atascado: 'ATASCADO (10 s sin avanzar)', limite_pasos: 'LÍMITE DE TIEMPO' };
const MODES = {
  evaluation: 'EVALUACIÓN · política congelada en una pista que nunca vio', baseline: 'REFERENCIA · reglas escritas a mano (no aprende)',
  incident: 'CONDICIÓN DIFÍCIL · evaluación con una perturbación', compare: 'MISMA PISTA Y MISMA FÍSICA · el coche amarillo y el azul salen juntos; las líneas muestran por dónde pasó cada uno',
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
  // Peso de cada rueda (vista desde arriba): el círculo crece con el peso.
  const loads = f.wheel_loads ?? [0.25, 0.25, 0.25, 0.25];
  ['wFL', 'wFR', 'wRL', 'wRR'].forEach((id, k) => {
    const el = $(id); const v = loads[k];
    el.setAttribute('r', (4 + 22 * Math.sqrt(Math.max(0, v))).toFixed(1));
    el.setAttribute('fill', v < 0.05 ? '#ff6b5b' : v > 0.35 ? '#ffd12e' : '#47df9a');
  });
  $('loadText').textContent = `Adelante ${Math.round((loads[0] + loads[1]) * 100)} % · Derecha ${Math.round((loads[1] + loads[3]) * 100)} %`;
  $('pitchDeg').textContent = `${(f.pitch_deg ?? 0) >= 0 ? '↓' : '↑'} ${Math.abs(f.pitch_deg ?? 0).toFixed(1)}°`;
  $('rollDeg').textContent = `${(f.roll_deg ?? 0) >= 0 ? '→' : '←'} ${Math.abs(f.roll_deg ?? 0).toFixed(1)}°`;
  $('heave').textContent = `${Math.round((f.heave_m ?? 0) * 100)} cm`;
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
  window.rallyV7Scenario = detail;
  window.dispatchEvent(new CustomEvent('rally7:scenario', { detail }));
  render();
}

window.addEventListener('rally7:tick', e => {
  if (e.detail.frame !== frameIndex) { frameIndex = e.detail.frame; render(); }
  if (e.detail.end && playing) { clearTimeout(window.__loop); window.__loop = setTimeout(() => startScenario(selected), 2500); }
});

function fillPlain() {
  const sel = data.selection, n6 = sel.n6_reference, ppo = data.summary.ppo, rules = data.baselines.reglas, im = sel.imitation_only;
  const prev = (sel.previous_attempts ?? []).at(-1), lap = sel.lap_time_s;
  const better = [], worse = [];
  const say = (ok, text) => (ok ? better : worse).push(text);
  say(ppo.normal.success_rate > n6.ppo_success_rate, `PPO termina ${pct(ppo.normal.success_rate)} de las vueltas. En el N6 terminaba ${pct(n6.ppo_success_rate)}${prev ? ` y sin maestro (intento 2), ${pct(prev.ppo_success_rate)}` : ''}.`);
  say(ppo.normal.mean_accidents < n6.ppo_mean_accidents, `Choca ${ppo.normal.mean_accidents.toFixed(2)} veces por vuelta. En el N6 chocaba ${n6.ppo_mean_accidents.toFixed(2)}.`);
  say(ppo.lluvia.success_rate > n6.ppo_rain_success_rate, `Con lluvia termina ${pct(ppo.lluvia.success_rate)} de las vueltas. En el N6, ${pct(n6.ppo_rain_success_rate)}.`);
  say(ppo.normal.success_rate >= rules.success_rate, `El alumno ${ppo.normal.success_rate >= rules.success_rate ? 'iguala o supera' : 'todavía no alcanza'} al maestro: PPO ${pct(ppo.normal.success_rate)}, reglas ${pct(rules.success_rate)}.`);
  if (lap?.ppo && lap?.reglas) say(lap.ppo <= lap.reglas, `Vuelta completa en ${lap.ppo.toFixed(1)} s. El maestro tarda ${lap.reglas.toFixed(1)} s.`);
  if (im) say(ppo.normal.success_rate > im.success_rate + 0.005, `Practicar solo con PPO después de imitar ${ppo.normal.success_rate > im.success_rate + 0.005 ? 'sumó' : 'no sumó'}: solo imitando ${pct(im.success_rate)} y ${im.mean_accidents.toFixed(2)} choques por vuelta; después de PPO ${pct(ppo.normal.success_rate)} y ${ppo.normal.mean_accidents.toFixed(2)}. Casi todo lo aprendió del maestro.`);
  say(ppo.sensor_ruidoso.success_rate >= 0.5, `Con sensores con ruido termina ${pct(ppo.sensor_ruidoso.success_rate)} de las vueltas.`);
  const col = (cls, title, items) => `<div class="plain-col ${cls}"><h3>${title}</h3><ul>${items.map(t => `<li>${t}</li>`).join('')}</ul></div>`;
  $('plainGrid').innerHTML = [
    col('what', 'Qué cambió', [
      'Antes PPO aprendía solo, a punta de chocar. Ahora primero <b>copia a un maestro</b>: las reglas escritas a mano, que terminan 87 % de las vueltas.',
      'Después de copiar, <b>practica por su cuenta</b> con PPO para pulir lo aprendido.',
      'La física, las 30 pistas del examen y la recompensa son las mismas. Solo cambió la forma de aprender.',
      'En pantalla: ruedas arregladas, polvo y humo, chispas al chocar, confeti en la meta, luces de freno y la línea que siguió cada coche.',
    ]),
    col('good', 'Qué mejoró', better.length ? better : ['Nada mejoró en este intento.']),
    col('bad', 'Qué no mejoró o falta', worse.length ? worse : ['Nada empeoró.']),
  ].join('');
}

function fillBench() {
  const sel = data.selection, n6 = sel.n6_reference, rules = data.baselines.reglas, crit = sel.criteria, im = sel.imitation_only;
  const ppo = data.summary.ppo.normal, ppoRain = data.summary.ppo.lluvia;
  const card = (label, before, after, ok, note) => `<div class="mud-card"><div class="label">${label}</div><div class="vals">${before ? `<span class="before">${before}</span>` : ''}<span class="after${ok ? '' : ' bad'}">${after}</span></div><small>${note}</small></div>`;
  $('mudCompare').innerHTML = [
    card('Vueltas completas · PPO', pct(n6.ppo_success_rate), pct(ppo.success_rate), sel.checks.ppo_llega_a_la_meta,
      `Tachado: N6. Meta: al menos ${pct(crit.min_success_rate_ppo)}.${im ? ` Solo imitando, antes de PPO: ${pct(im.success_rate)}.` : ''}`),
    card('Accidentes por vuelta · PPO', n6.ppo_mean_accidents.toFixed(2), ppo.mean_accidents.toFixed(2), sel.checks.ppo_choca_menos_que_n6,
      `Meta: menos que el N6. Velocidad media al chocar: ${ppo.mean_crash_kmh == null ? '—' : Math.round(ppo.mean_crash_kmh) + ' km/h'}.`),
    card('Vueltas completas · reglas', pct(n6.rules_success_rate), pct(rules.success_rate), sel.checks.reglas_conservan_exito,
      `Misma física que el N6: las reglas no deberían cambiar. Meta: al menos ${pct(crit.min_success_rate_rules)}.`),
    card('PPO con lluvia', pct(n6.ppo_rain_success_rate), pct(ppoRain.success_rate), ppoRain.success_rate >= n6.ppo_rain_success_rate,
      'No es parte de la hipótesis. PPO nunca practicó con lluvia; el maestro termina ' + pct(data.baselines.reglas_lluvia.success_rate) + '.'),
  ].join('');
  $('selection').textContent = sel.accepted ? 'HIPÓTESIS CONFIRMADA' : 'HIPÓTESIS NO CONFIRMADA (ver cada criterio)';
  $('selection').className = sel.accepted ? 'ok' : 'bad';
  $('hypothesis').textContent = `Hipótesis: ${data.config.experiment.hypothesis}` +
    (data.tracking.startsWith('omitido') ? ' Nota: datos generados sin DVC ni MLflow; la corrida oficial se repite con tracking.' : '');
}

function fillAttempts() {
  const e = data.config.experiment, prevs = e.previous_attempts ?? [];
  if (!prevs.length) return;
  const ppo = data.summary.ppo.normal, q = data.summary.qlearning.normal, sel = data.selection;
  const box = (title, ok, okLabel, items, big) => `<div class="attempt"><h3>${title}<em class="${ok ? 'ok' : ''}">${okLabel}</em></h3><div class="big">${big}</div><ul>${items.map(i => `<li>${i}</li>`).join('')}</ul></div>`;
  $('attemptGrid').innerHTML = [
    ...prevs.map((p, i) => box(`Intento ${i + 1} · ${p.date}`, false, 'RECHAZADO', [
      p.what,
      `PPO ${pct(p.ppo_success_rate)} (semillas ${p.ppo_by_seed.map(pct).join(' / ')}) · Q-learning ${pct(p.qlearning_success_rate)} · reglas ${pct(p.rules_success_rate)}`,
      `${p.ppo_mean_accidents.toFixed(2)} accidentes por vuelta, a ${Math.round(p.ppo_mean_crash_kmh)} km/h en promedio`,
      ...(p.diagnosis ?? []),
    ], `PPO ${pct(p.ppo_success_rate)}`)),
    box(`Intento ${e.attempt} · con maestro`, sel.accepted, sel.accepted ? 'ACEPTADO' : 'RECHAZADO', [
      `PPO ${pct(ppo.success_rate)} (semillas ${data.runs.filter(r => r.algorithm === 'ppo').map(r => pct(r.evaluation.normal.success_rate)).join(' / ')}) · Q-learning ${pct(q.success_rate)} · reglas ${pct(sel.rules_success_rate)}`,
      `${ppo.mean_accidents.toFixed(2)} accidentes por vuelta${ppo.mean_crash_kmh == null ? '' : `, a ${Math.round(ppo.mean_crash_kmh)} km/h en promedio`}`,
      ...(e.changes_vs_attempt_2 ?? []),
    ], `PPO ${pct(ppo.success_rate)}`),
  ].join('');
  $('attemptNote').textContent = `Los intentos rechazados siguen guardados: ${prevs.map((p, i) => `intento ${i + 1}, informe ${p.report}${p.commit ? ` (commit ${p.commit})` : ''}`).join('; ')}. En los tres la física, la mirada de piloto y las 30 pistas son las mismas.`;
  $('attempts').hidden = false;
}

function fillTable() {
  const rows = [];
  const old = v6 ? { aleatoria: v6.baselines.aleatoria, reglas: v6.baselines.reglas, reglas_lluvia: v6.baselines.reglas_lluvia, ...v6.summary } : null;
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
    tr.innerHTML = `<td>${r.name}</td><td>${r.cond}</td><td>${pct(r.s.success_rate)}</td><td class="n4">${pct(r.n4?.success_rate)}</td><td>${signed(r.s.mean_return)}</td><td>${t ? t.toFixed(1) + ' s' : '—'}</td><td>${r.s.mean_accidents.toFixed(2)}</td><td>${r.s.mean_crash_kmh == null ? '—' : Math.round(r.s.mean_crash_kmh) + ' km/h'}</td><td>${r.s.mean_slip_deg == null ? '—' : r.s.mean_slip_deg.toFixed(1) + '°'}</td>`;
    return tr;
  }));
}

function fillExplainer() {
  const ic = data.config.training.imitation ?? {}, pc = data.config.training.ppo, rw = data.config.reward;
  const items = [
    ['1. El maestro maneja', `Las reglas escritas a mano dan ${ic.episodes_per_round ?? 60} vueltas en pistas de práctica. En cada instante (4 veces por segundo) se anota qué veía el coche y qué hizo el maestro con el pedal y el volante.`],
    ['2. El alumno maneja y el maestro corrige', `En las ${(ic.rounds ?? 8) - 1} rondas siguientes maneja la red. Cuando se equivoca y queda en un lugar raro, el maestro anota qué habría hecho él ahí. Así el alumno aprende a corregirse, no solo a copiar vueltas perfectas. Esta técnica se llama DAgger.`],
    ['3. La red estudia las notas', `Después de cada ronda la red (${pc.net_arch.join(' × ')} neuronas; antes 64 × 64) repasa todas las notas ${ic.epochs ?? 30} veces hasta que su pedal y su volante se parecen a los del maestro.`],
    ['4. Práctica libre con PPO', `Ya sabiendo manejar, practica ${Math.round(pc.total_timesteps / 1000)} mil pasos con la recompensa de siempre (+${rw.per_meter} por metro, ${rw.accident} por accidente, +${rw.finish} al terminar). Da pasos pequeños para no dañar lo aprendido y se guarda el mejor momento.`],
    ['Lo que NO cambió', 'La física es la del N6, la mirada de piloto es la de los intentos 1 y 2, y el examen son las mismas 30 pistas que ningún modelo usó para entrenar. Por eso la diferencia se le puede atribuir a la forma de aprender.'],
    ['Nuevo en pantalla', 'Línea amarilla y azul: por dónde pasó cada coche. Polvo en el pasto, humo blanco cuando las llantas patinan, humo oscuro y chispas en cada choque, confeti al cruzar la meta y luces rojas al frenar. Las ruedas ya no bambolean: el modelo 3D las traía torcidas.'],
  ];
  $('explainGrid').innerHTML = items.map(([h, b]) => `<div><b>${h}</b>${b}</div>`).join('');
}

function drawImitation() {
  const svg = $('imitationChart'), NS = 'http://www.w3.org/2000/svg';
  const runs = data.runs.filter(r => r.imitation?.curve?.length);
  if (!runs.length) { svg.remove(); return; }
  const W = 720, H = 220, m = { l: 46, r: 16, t: 14, b: 34 }, n = runs[0].imitation.curve.length;
  const x = v => m.l + (W - m.l - m.r) * v / (n - 1), y = v => H - m.b - (H - m.t - m.b) * v;
  const el = (t, a) => { const node = document.createElementNS(NS, t); for (const k in a) node.setAttribute(k, a[k]); svg.appendChild(node); return node; };
  svg.replaceChildren();
  for (const v of [0, 0.25, 0.5, 0.75, 1]) { el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: '#2d3a46' }); el('text', { x: 8, y: y(v) + 4 }).textContent = `${v * 100}%`; }
  for (let i = 0; i < n; i++) el('text', { x: x(i) - 22, y: H - 10 }).textContent = `ronda ${i}`;
  runs.forEach((r, k) => {
    const pts = r.imitation.curve;
    el('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.validation_success_rate ?? 0).toFixed(1)}`).join(' '), fill: 'none', stroke: '#ffc320', 'stroke-width': 2.2, opacity: 1 - k * 0.25 });
    pts.forEach((p, i) => el('circle', { cx: x(i), cy: y(p.validation_success_rate ?? 0), r: 3.5, fill: '#ffc320', opacity: 1 - k * 0.25 }));
  });
  el('line', { x1: m.l, x2: W - m.r, y1: y(data.baselines.reglas.success_rate), y2: y(data.baselines.reglas.success_rate), stroke: '#5a8ee8', 'stroke-dasharray': '6 5', 'stroke-width': 1.6 });
  el('text', { x: W - 250, y: y(data.baselines.reglas.success_rate) - 6, style: 'fill:#5a8ee8' }).textContent = 'el maestro en las 30 pistas del examen';
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
  const res = await fetch('v7-results.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('No están las corridas v7. Ejecuta: python pipeline_v7.py');
  data = await res.json();
  try { const r6 = await fetch('v6-results.json', { cache: 'no-store' }); if (r6.ok) v6 = await r6.json(); } catch { v6 = null; }
  window.rallyV7Data = data;
  scenarios = data.scenarios;
  const r = data.config.reward;
  $('rewardRule').textContent = `Recompensa: +${r.per_meter} por metro nuevo · +${r.checkpoint} por checkpoint · ${r.step} por paso de 0,25 s · ${r.accident} por accidente (incluye trompo) · ${r.stalled} si se atasca · +${r.finish} al terminar y +${r.remaining_fuel_per_l} por litro sobrante.`;
  const rec = data.runs.find(x => x.run_id === data.selection.recommended_run_id);
  $('modelInfo').textContent = rec ? `Modelo recomendado: PPO semilla ${rec.seed} · ${rec.run_id} · SHA-256 ${rec.model_sha256.slice(0, 12)}… · paquete en modelos/n7/ppo-recomendado/ (model.zip, policy.onnx, normalization.json, manifest.json)` : '';
  $('replaySelect').replaceChildren(...scenarios.map((s, i) => new Option(s.label, String(i))));
  $('replaySelect').disabled = $('toggle').disabled = false;
  fillPlain(); fillBench(); fillAttempts(); fillTable(); fillExplainer(); drawCurves(); drawImitation();
  const params = new URLSearchParams(location.search);
  let wanted = scenarios.findIndex(s => s.id === params.get('escenario'));
  if (wanted < 0) wanted = scenarios.findIndex(s => s.id === 'alumno-maestro-0');
  window.rallyV7Scenario = null;
  await import('./scene-v7.js');
  startScenario(wanted >= 0 ? wanted : 0);
  $('loadStatus').textContent = 'Reproducción de carreras reales calculadas por Python (física cada 0,025 s). Ninguna de estas pistas se usó para entrenar.';
  $('replaySelect').onchange = () => startScenario(Number($('replaySelect').value));
  $('toggle').onclick = () => { playing = !playing; $('toggle').textContent = playing ? 'Pausar' : 'Reanudar'; window.dispatchEvent(new CustomEvent('rally7:control', { detail: { paused: !playing } })); };
  $('reset').onclick = () => startScenario(selected);
  $('speed').onchange = () => { stepMs = Number($('speed').value); startScenario(selected); };
  $('exaggerate').onchange = () => window.dispatchEvent(new CustomEvent('rally7:exaggerate', { detail: $('exaggerate').checked ? 3 : 1 }));
  $('trailToggle').onchange = () => window.dispatchEvent(new CustomEvent('rally7:trails', { detail: $('trailToggle').checked }));
  $('lookToggle').onchange = () => window.dispatchEvent(new CustomEvent('rally7:look', { detail: $('lookToggle').checked }));
  setTimeout(() => window.dispatchEvent(new CustomEvent('rally7:look', { detail: $('lookToggle').checked })), 1500);
} catch (error) {
  console.error(error);
  $('loadStatus').textContent = error.message;
  $('sceneStatus').textContent = 'No se pudo cargar la reproducción v7.';
}
