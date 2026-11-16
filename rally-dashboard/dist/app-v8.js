// Página del N8. Todo sale de v8-results.json (lo escribe pipeline_v8.py) y de catalogo.json (lo escribe
// build_catalog.py). La web no entrena ni simula: dibuja lo que Python calculó.
const $ = id => document.getElementById(id);
const signed = (n, d = 1) => `${n >= 0 ? '+' : ''}${Number(n).toFixed(d)}`;
const pct = n => (n == null ? '—' : `${Math.round(n * 100)} %`);
const int = n => (n == null ? '—' : Math.round(n).toLocaleString('es-CO'));
const secs = n => (n == null ? '—' : `${n.toFixed(1)} s`);
const big = n => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace('.', ',')} M` : int(n));
let data, catalog = null, scenarios = [], selected = 0, frameIndex = 0, playing = true, stepMs = 250, lastToast = -1;

const TERRAIN = { asfalto: 'Asfalto', lodo: 'Barro', agua: 'Agua', pasto: 'Pasto', foso: 'Foso', rampa: 'Rampa', valla: 'Valla', puente: 'Puente', aire: 'En el aire' };
const EVENTS = {
  pisa_lodo: 'Entra al barro', pisa_agua: 'Pisa agua: poco agarre', pisa_pasto: 'Se sale al pasto', derrapa: 'Derrapa', patina_al_acelerar: 'Las ruedas patinan',
  bloquea_los_frenos: 'Bloquea los frenos', hace_un_trompo: '¡Trompo!', salta_la_rampa: '¡Salta la rampa!', aterriza: 'Aterriza', aterriza_en_el_puente: 'Aterriza sobre el puente',
  vuela_sobre_el_hueco: 'Vuela sobre el hueco del puente', se_sale_del_puente: 'Se sale del borde del puente', cae_del_puente: 'Cae del puente', cae_al_foso: 'Cae al foso',
  cae_en_foso: 'Accidente en el foso', choca_con_la_valla: 'Choca con la valla', frena_contra_la_valla: 'Se detiene contra la valla', sale_de_la_pista: 'Se sale de la pista',
  sale_volando_de_la_pista: 'Sale volando de la pista', aterrizaje_duro: 'Aterrizaje demasiado duro', choca_con_el_borde_del_puente: 'Choca con el borde del puente',
  levanta_una_rueda: 'Levanta una rueda', golpea_los_topes: 'La suspensión toca fondo',
};
const QUIET = new Set(['pisa_lodo', 'pisa_agua', 'pisa_pasto', 'derrapa', 'patina_al_acelerar', 'bloquea_los_frenos', 'aterriza', 'levanta_una_rueda']);
const STATUS = { en_curso: ['EN CARRERA', ''], vuelta_completada: ['VUELTA COMPLETA', 'done'], demasiados_accidentes: ['5 ACCIDENTES: FUERA', 'fail'], atascado: ['ATASCADO', 'fail'], limite_pasos: ['SE ACABÓ EL TIEMPO', 'fail'] };
const MODES = { baseline: 'REFERENCIA · reglas escritas a mano', incident: 'CONDICIÓN DIFÍCIL · misma pista con una perturbación', compare: 'MISMA PISTA · los dos coches salen juntos' };
const CAUSE = {
  vuelta_completada: ['Llegó a la meta', '#47df9a'], demasiados_accidentes: ['5 accidentes', '#ff6b5b'], atascado: ['Atascado 10 s', '#ffb45a'],
  limite_pasos: ['Límite de 150 s', '#8a97a3'], corte_de_entrenamiento: ['Corte a los 100 s', '#5a8ee8'],
};
const SEED_COLORS = ['#ffd12e', '#47df9a', '#ff8a7a', '#7fb0ff', '#d07bff'];

function toast(text) { const el = $('eventToast'); el.textContent = text; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 1600); }
const bar = (el, v, color) => { el.style.left = v >= 0 ? '50%' : `${50 + v * 50}%`; el.style.width = `${Math.abs(v) * 50}%`; el.style.background = color ?? (v >= 0 ? '#47df9a' : '#ff6b5b'); };

function render() {
  const sc = scenarios[selected], f = sc.frames[Math.min(frameIndex, sc.frames.length - 1)];
  $('speedKmh').textContent = Math.round(f.speed_kmh);
  $('progress').textContent = Math.round(f.progress_pct);
  $('progressBar').style.width = `${f.progress_pct}%`;
  $('distance').textContent = `${Math.round(Math.min(f.s, data.track_length))} de ${Math.round(data.track_length)} m`;
  $('time').textContent = `${(f.steps * data.config.physics.dt_s).toFixed(1)} s`;
  $('accidents').textContent = `${f.accidents}`;
  $('here').textContent = TERRAIN[f.terrain_here] ?? f.terrain_here;
  const [thr, steer] = f.action ?? [0, 0], maxSteer = data.config.physics.max_steer_rad * 180 / Math.PI;
  bar($('pedalBar'), f.pedal ?? 0); bar($('steerRealBar'), (f.steer_deg ?? 0) / maxSteer, '#ffd12e');
  bar($('throttleBar'), thr); bar($('steerBar'), steer, '#ffd12e');
  const [label, cls] = STATUS[f.termination_cause] ?? [f.termination_cause, ''];
  $('status').textContent = label; $('status').className = cls;
  // Telemetría completa (plegable)
  const base = f.terrain_here === 'aire' ? null : (f.terrain_here === 'puente' ? 1 : data.config.terrains[f.terrain_here]?.grip);
  $('speedMs').textContent = `${f.speed_mps.toFixed(1)} m/s`;
  $('grip').textContent = base == null ? '—' : (base * (/lluvia/i.test(sc.id) ? 0.7 : 1)).toFixed(2);
  $('slipDeg').textContent = `${Math.abs(f.slip_deg ?? 0).toFixed(1)}°`;
  $('steerDeg').textContent = `${(f.steer_deg ?? 0).toFixed(1)}°`;
  $('yaw').textContent = `${((f.yaw_rate ?? 0) * 180 / Math.PI).toFixed(0)}°/s`;
  $('pitchDeg').textContent = `${(f.pitch_deg ?? 0) >= 0 ? '↓' : '↑'} ${Math.abs(f.pitch_deg ?? 0).toFixed(1)}°`;
  $('rollDeg').textContent = `${(f.roll_deg ?? 0) >= 0 ? '→' : '←'} ${Math.abs(f.roll_deg ?? 0).toFixed(1)}°`;
  $('heave').textContent = `${Math.round((f.heave_m ?? 0) * 100)} cm`;
  $('height').textContent = `${f.z.toFixed(1)} m${f.airborne ? ' · aire' : ''}`;
  $('lane').textContent = `${f.lane + 1} de 4`;
  $('cps').textContent = `${f.checkpoints} de ${Math.floor(data.track_length / data.config.track.checkpoint_every_m)}`;
  const loads = f.wheel_loads ?? [0.25, 0.25, 0.25, 0.25];
  $('loadText').textContent = `${Math.round((loads[0] + loads[1]) * 100)} % / ${Math.round((loads[1] + loads[3]) * 100)} %`;
  $('reward').textContent = signed(f.reward ?? 0, 2);
  $('trackScore').textContent = signed(f.return ?? 0);
  const said = (f.events || []).map(e => EVENTS[e] ?? e);
  $('events').textContent = said.length ? said.join(' · ') : '—';
  const loud = (f.events || []).filter(e => !QUIET.has(e)).map(e => EVENTS[e] ?? e);
  if (loud.length && frameIndex !== lastToast) { toast(loud.at(-1)); lastToast = frameIndex; }
}

function startScenario(i) {
  selected = i; frameIndex = 0; $('replaySelect').value = String(i);
  const sc = scenarios[i];
  $('modeBanner').textContent = MODES[sc.mode] ?? sc.mode;
  $('policyName').textContent = sc.policy;
  $('legendCars').innerHTML = `<span><b style="background:#ffc320"></b>${sc.policy}</span>` + (sc.ghost ? `<span><b style="background:#5a8ee8"></b>${sc.ghost.policy}</span>` : '');
  const detail = { layout: sc.layout, frames: sc.frames, ghost: sc.ghost, stepMs, frameIndex: 0, paused: !playing };
  window.rallyV8Scenario = detail;
  window.dispatchEvent(new CustomEvent('rally8:scenario', { detail }));
  render();
}
window.addEventListener('rally8:tick', e => {
  if (e.detail.frame !== frameIndex) { frameIndex = e.detail.frame; render(); }
  if (e.detail.end && playing) { clearTimeout(window.__loop); window.__loop = setTimeout(() => startScenario(selected), 3000); }
});
window.addEventListener('rally8:fps', e => {
  const d = e.detail;
  $('perf').textContent = `${d.fps} fps · ${Math.round(d.pixelRatio * 100)} %${d.shadows ? '' : ' · sin sombras'}`;
});

// ---------- gráficos de líneas (SVG a mano: ligeros y con texto legible) ----------
function lineChart(svg, { series, yMax = 1, yMin = 0, yFmt = v => `${Math.round(v * 100)}%`, xFmt = v => v, xTicks, refs = [] }) {
  const NS = 'http://www.w3.org/2000/svg', W = 560, H = 260, m = { l: 44, r: 14, t: 12, b: 30 };
  const xs = series.flatMap(s => s.points.map(p => p[0])), xMax = Math.max(...xs, 1), xMin = Math.min(...xs, 0);
  const x = v => m.l + (W - m.l - m.r) * (v - xMin) / Math.max(1e-9, xMax - xMin), y = v => H - m.b - (H - m.t - m.b) * (v - yMin) / (yMax - yMin);
  const el = (t, a, text) => { const n = document.createElementNS(NS, t); for (const k in a) n.setAttribute(k, a[k]); if (text != null) n.textContent = text; svg.appendChild(n); return n; };
  svg.replaceChildren();
  for (let i = 0; i <= 4; i++) { const v = yMin + (yMax - yMin) * i / 4; el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: '#2d3a46' }); el('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, yFmt(v)); }
  for (const v of xTicks ?? [xMin, (xMin + xMax) / 2, xMax]) el('text', { x: x(v), y: H - 9, 'text-anchor': 'middle' }, xFmt(v));
  for (const r of refs) { el('line', { x1: m.l, x2: W - m.r, y1: y(r.y), y2: y(r.y), stroke: r.color ?? '#5a8ee8', 'stroke-dasharray': '6 5', 'stroke-width': 1.5 }); el('text', { x: W - m.r - 4, y: y(r.y) - 5, 'text-anchor': 'end', style: `fill:${r.color ?? '#5a8ee8'}` }, r.label); }
  series.forEach(s => {
    const pts = s.points.filter(p => p[1] != null);
    if (!pts.length) return;
    el('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round' });
    if (s.best) el('circle', { cx: x(s.best[0]), cy: y(s.best[1]), r: 5, fill: s.color, stroke: '#0f161d', 'stroke-width': 2 });
    if (s.stop) { const [sx, sy] = [x(s.stop[0]), y(s.stop[1])]; el('path', { d: `M${sx - 5} ${sy - 5}L${sx + 5} ${sy + 5}M${sx - 5} ${sy + 5}L${sx + 5} ${sy - 5}`, stroke: s.color, 'stroke-width': 2.5, fill: 'none' }); }
  });
  series.forEach((s, i) => { el('rect', { x: m.l + 8 + i * 92, y: m.t + 2, width: 10, height: 10, rx: 2, fill: s.color }); el('text', { x: m.l + 22 + i * 92, y: m.t + 11 }, s.name); });
}

// ---------- pestaña Resumen ----------
// Tarjetas grandes arriba: el resultado del modelo contra el maestro, con números que cuentan hacia arriba
// y una barra que marca dónde está el maestro (la línea blanca).
function fillKpis(n, rules) {
  const k = [
    { label: 'Vueltas completas', v: n.success_rate * 100, unit: ' %', ref: rules.success_rate * 100, max: 100, good: n.success_rate >= rules.success_rate, note: `maestro ${pct(rules.success_rate)}` },
    { label: 'Vueltas sin choques', v: n.clean_rate * 100, unit: ' %', ref: rules.clean_rate * 100, max: 100, good: n.clean_rate >= rules.clean_rate, note: `maestro ${pct(rules.clean_rate)}` },
    { label: 'Tiempo de vuelta', v: n.mean_time_s_success, unit: ' s', dec: 1, ref: rules.mean_time_s_success, max: 90, good: n.mean_time_s_success <= rules.mean_time_s_success, note: `maestro ${secs(rules.mean_time_s_success)} · menos es mejor` },
    { label: 'Choques por vuelta', v: n.mean_accidents, unit: '', dec: 2, ref: rules.mean_accidents, max: 2, good: n.mean_accidents <= rules.mean_accidents, note: `maestro ${rules.mean_accidents.toFixed(2)} · menos es mejor` },
  ];
  $('kpis').innerHTML = k.map((x, i) => `<div class="kpi" style="--c:${x.good ? 'var(--ok)' : 'var(--accent)'}"><span>${x.label}</span><b data-to="${x.v}" data-dec="${x.dec ?? 0}" data-unit="${x.unit}">0${x.unit}</b><small>${x.note}</small><i class="vs"><i data-w="${Math.min(100, x.v / x.max * 100)}" style="width:0"></i><em style="left:${Math.min(100, x.ref / x.max * 100)}%"></em></i></div>`).join('');
  const t0 = performance.now(), els = [...$('kpis').querySelectorAll('b[data-to]')];
  const tick = now => {
    const f = Math.min(1, (now - t0) / 1100), e = 1 - Math.pow(1 - f, 3);
    for (const b of els) { const to = +b.dataset.to, d = +b.dataset.dec; b.textContent = (to * e).toFixed(d).replace('.', ',') + b.dataset.unit; }
    if (f < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  requestAnimationFrame(() => $('kpis').querySelectorAll('.vs > i').forEach(i => { i.style.width = i.dataset.w + '%'; }));
}
// Las secciones aparecen suavemente al bajar con el scroll.
function revealOnScroll() {
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.08 });
  document.querySelectorAll('.panel .plain-col, .panel .card, .panel .stat, .panel figure, .panel .table-wrap, .panel .steps > div, .panel .gloss > div').forEach(el => { if (!el.classList.contains('reveal')) { el.classList.add('reveal'); io.observe(el); } });
  // Seguro: si algo no se vio (por ejemplo al imprimir o en una captura), a los 4 s aparece igual.
  setTimeout(() => document.querySelectorAll('.reveal:not(.in)').forEach(el => el.classList.add('in')), 4000);
}
function fillSummary() {
  const sel = data.selection, n7 = sel.n7_reference, ppo = data.summary.ppo, rules = sel.rules, im = sel.imitation_only, tt = data.training_totals;
  const n = ppo.normal, pc = data.config.training.ppo;
  $('oneLine').innerHTML = `PPO termina <b>${pct(n.success_rate)}</b> de las vueltas y <b>${pct(n.clean_rate)}</b> sin un solo choque, en <b>${secs(n.mean_time_s_success)}</b> por vuelta. El maestro: ${pct(rules.success_rate)}, ${pct(rules.clean_rate)} y ${secs(rules.mean_time_s_success)}.`;
  fillKpis(n, rules);
  const better = [], worse = [];
  const say = (ok, text) => (ok ? better : worse).push(text);
  say(n.clean_rate > rules.clean_rate, `Vueltas limpias (sin ningún choque): PPO ${pct(n.clean_rate)}, el maestro ${pct(rules.clean_rate)}.`);
  say(n.success_rate > n7.ppo_success_rate, `Vueltas completas: ${pct(n.success_rate)}. En el N7 eran ${pct(n7.ppo_success_rate)}; el maestro, ${pct(rules.success_rate)}.`);
  say(n.mean_time_s_success != null && n.mean_time_s_success < rules.mean_time_s_success, `Tiempo de vuelta: ${secs(n.mean_time_s_success)}. El maestro tarda ${secs(rules.mean_time_s_success)} y el N7 tardaba ${secs(n7.ppo_lap_time_s)}.`);
  say(n.mean_accidents < n7.ppo_mean_accidents, `Choques por vuelta: ${n.mean_accidents.toFixed(2)}. En el N7 eran ${n7.ppo_mean_accidents.toFixed(2)}; el maestro, ${rules.mean_accidents.toFixed(2)}.`);
  say(ppo.lluvia.success_rate > n7.ppo_rain_success_rate, `Con lluvia termina ${pct(ppo.lluvia.success_rate)} de las vueltas (N7: ${pct(n7.ppo_rain_success_rate)}).`);
  say(ppo.sensor_ruidoso.success_rate > n7.ppo_noise_success_rate, `Con sensores con ruido termina ${pct(ppo.sensor_ruidoso.success_rate)} (N7: ${pct(n7.ppo_noise_success_rate)}).`);
  say(n.clean_rate > im.clean_rate + 0.005, `Practicar con PPO después de imitar ${n.clean_rate > im.clean_rate + 0.005 ? 'sí sumó' : 'no sumó'}: solo imitando ${pct(im.clean_rate)} de vueltas limpias; después de PPO, ${pct(n.clean_rate)}.`);
  const col = (cls, title, items) => `<div class="plain-col ${cls}"><h3>${title}</h3><ul>${items.map(t => `<li>${t}</li>`).join('')}</ul></div>`;
  $('plainGrid').innerHTML = [
    col('what', 'Qué cambió', [
      `<b>Se entrena mucho más</b>: hasta ${big(pc.total_timesteps)} de pasos por modelo (en el N7 eran 400 mil), y practica también con lluvia y con sensores con ruido.`,
      `<b>Parada temprana</b>: si lleva ${pc.patience_evals} exámenes seguidos sin mejorar, se detiene sola. Ahorró ${big(tt.steps_saved_by_early_stopping)} de pasos.`,
      `<b>Se cuentan los episodios</b>: ${int(tt.episodes)} carreras de entrenamiento y cómo terminó cada una.`,
      'La meta ya no es solo llegar: primero vueltas <b>sin chocar</b>, después el <b>tiempo</b>. El coche, la pista, los sensores y las 30 pistas del examen son los mismos.',
      'En pantalla: pantalla completa, el centro del óvalo con pits y lago, modo día, atardecer y noche, y la imagen más fluida.',
      ...(data.config.experiment.previous_attempts?.length ? [`<b>Intento ${data.selection.attempt}</b>: continúa desde el mejor punto del intento 1 (sin repetir la imitación). En el intento 1: ${pct(data.config.experiment.previous_attempts[0].clean_rate)} de vueltas limpias, ${pct(data.config.experiment.previous_attempts[0].success_rate)} completas y ${data.config.experiment.previous_attempts[0].mean_accidents.toFixed(2)} choques por vuelta. Los números de esta página suman los dos intentos.`] : []),
    ]),
    col('good', 'Qué mejoró', better.length ? better : ['Nada mejoró en este intento.']),
    col('bad', 'Qué no mejoró o falta', worse.length ? worse : ['Nada empeoró frente al N7 ni al maestro.']),
  ].join('');

  const crit = sel.criteria;
  const card = (label, before, after, ok, note) => `<div class="card"><div class="label">${label}</div><div class="vals"><span class="after${ok ? '' : ' bad'}">${after}</span><span class="before">${before}</span></div><small>${note}</small></div>`;
  $('criteria').innerHTML = [
    card('Vueltas limpias · PPO', `maestro ${pct(rules.clean_rate)}`, pct(n.clean_rate), sel.checks.mas_vueltas_limpias_que_el_maestro, `Meta: al menos ${pct(crit.min_clean_rate_ppo)} (más que el maestro). Por semilla: ${sel.by_seed.clean_rate.map(pct).join(' / ')}.`),
    card('Tiempo de vuelta · PPO', `maestro ${secs(rules.mean_time_s_success)}`, secs(n.mean_time_s_success), sel.checks.mas_rapido_que_el_maestro, `Meta: ${secs(crit.max_lap_time_s_ppo)} o menos. Por semilla: ${sel.by_seed.mean_time_s_success.map(secs).join(' / ')}.`),
    card('Vueltas completas con lluvia · PPO', `N7 ${pct(n7.ppo_rain_success_rate)}`, pct(ppo.lluvia.success_rate), sel.checks.aguanta_la_lluvia, `Meta: al menos ${pct(crit.min_success_rate_rain_ppo)}. El maestro con lluvia: ${pct(data.baselines.reglas_lluvia.success_rate)}.`),
  ].join('');
  const passed = Object.values(sel.checks).filter(Boolean).length;
  $('selection').textContent = sel.accepted ? 'CONFIRMADA' : `NO CONFIRMADA · ${passed} de ${Object.keys(sel.checks).length}`;
  $('selection').className = sel.accepted ? 'ok' : 'bad';
  $('hypothesis').textContent = data.config.experiment.hypothesis + (data.tracking.startsWith('omitido') ? ' Nota: datos generados sin DVC ni MLflow; la corrida oficial se repite con tracking.' : '');

  const rows = [], b = data.baselines, L = { normal: 'Normal', lluvia: 'Lluvia', sensor_ruidoso: 'Sensores con ruido' };
  const add = (name, cond, s, best) => s && rows.push({ name, cond, s, best });
  add('Azar', 'Normal', b.aleatoria); add('Reglas · el maestro', 'Normal', b.reglas); add('Reglas · el maestro', 'Lluvia', b.reglas_lluvia);
  add('PPO del N7', 'Normal', b.ppo_n7); add('PPO del N7', 'Lluvia', b.ppo_n7_lluvia); add('PPO del N7', 'Sensores con ruido', b.ppo_n7_ruido);
  for (const c of ['normal', 'lluvia', 'sensor_ruidoso']) add('PPO del N8', L[c], ppo[c], c === 'normal');
  $('compareTable').tBodies[0].replaceChildren(...rows.map(r => {
    const tr = document.createElement('tr'); if (r.best) tr.className = 'best';
    tr.innerHTML = `<td>${r.name}</td><td>${r.cond}</td><td class="num">${pct(r.s.success_rate)}</td><td class="num">${pct(r.s.clean_rate)}</td><td class="num">${secs(r.s.mean_time_s_success)}</td><td class="num">${r.s.mean_accidents.toFixed(2)}</td><td class="num">${r.s.mean_crash_kmh == null ? '—' : Math.round(r.s.mean_crash_kmh) + ' km/h'}</td>`;
    return tr;
  }));
}

// ---------- pestaña Entrenamiento ----------
function fillTraining() {
  const tt = data.training_totals, pc = data.config.training.ppo, ic = data.config.training.imitation, runs = data.runs, rules = data.selection.rules;
  const stat = (label, value, small) => `<div class="stat"><span>${label}</span><b>${value}</b><small>${small}</small></div>`;
  const mins = Math.round(tt.train_seconds / 60);
  $('trainStats').innerHTML = [
    stat('Episodios de entrenamiento', int(tt.episodes), `${int(tt.by_phase.imitacion?.episodes)} imitando + ${int(tt.by_phase.practica_ppo?.episodes)} practicando, en ${tt.models} modelos`),
    stat('Pasos (decisiones)', big(tt.steps), `≈ ${int(tt.steps * data.config.physics.dt_s / 3600)} horas de manejo simulado`),
    stat('Pasos ahorrados', big(tt.steps_saved_by_early_stopping), `${tt.early_stopped_runs} de ${tt.models} modelos pararon solos antes del límite de ${big(pc.total_timesteps)}`),
    stat('Duración media de un episodio', `${Math.round(tt.steps / tt.episodes)} pasos`, `${(tt.steps / tt.episodes * data.config.physics.dt_s).toFixed(0)} s de carrera · práctica PPO: ${mins} min de cómputo`),
  ].join('');

  const phases = [['imitacion', 'Imitación (DAgger)'], ['practica_ppo', 'Práctica (PPO)']];
  const rowsHtml = phases.filter(([k]) => tt.by_phase[k]).map(([k, label]) => {
    const p = tt.by_phase[k];
    const segs = Object.entries(CAUSE).map(([c, [name, color]]) => { const n = p.by_cause[c] ?? 0; return n ? `<i style="width:${(n / p.episodes * 100).toFixed(2)}%;background:${color}" title="${name}: ${int(n)} (${Math.round(n / p.episodes * 100)} %)"></i>` : ''; }).join('');
    return `<div class="cause-row"><span><b>${label}</b></span><div class="track">${segs}</div><span class="n">${int(p.episodes)} episodios · ${Math.round(p.by_cause.vuelta_completada / p.episodes * 100)} % a la meta</span></div>`;
  }).join('');
  $('causeBars').innerHTML = rowsHtml + `<div class="cause-legend">${Object.entries(CAUSE).map(([c, [name, color]]) => `<span><b style="background:${color}"></b>${name}: ${int(tt.by_cause[c] ?? 0)}</span>`).join('')}</div>`;

  $('seedTable').tBodies[0].replaceChildren(...runs.map(r => {
    const im = r.imitation, es = r.early_stopping, ep = r.episodes, n = r.evaluation.normal;
    const tr = document.createElement('tr'); if (r.run_id === data.selection.recommended_run_id) tr.className = 'best';
    tr.innerHTML = `<td>${r.seed}${r.run_id === data.selection.recommended_run_id ? ' · recomendado' : ''}</td>
      <td>${im.rounds_run} de ${im.max_rounds}${im.stopped_early ? ' · paró sola' : ''}<br><small class="approx">mejor: ronda ${im.best_round}</small></td>
      <td class="num">${int(ep.imitacion?.episodes)}</td>
      <td class="num">${big(es.timesteps_run)} de ${big(es.timesteps_budget)}</td>
      <td class="num">${int(ep.practica_ppo?.episodes)}</td>
      <td>${es.stopped_early ? 'Parada temprana: ' + es.reason : 'Llegó al límite de pasos'}</td>
      <td class="num">${r.chosen_checkpoint.timesteps < 100 ? 'solo imitación (paso 0)' : big(r.chosen_checkpoint.timesteps) + ' pasos'}</td>
      <td class="num">${pct(n.clean_rate)} / ${pct(n.success_rate)}</td>`;
    return tr;
  }));

  const series = key => runs.map((r, i) => {
    const pts = r.curves.evaluacion.map(p => [p.timesteps, p[key]]), bestP = r.curves.evaluacion.find(p => p.timesteps === r.chosen_checkpoint.timesteps), last = r.curves.evaluacion.at(-1);
    return { name: `semilla ${r.seed}`, color: SEED_COLORS[i % SEED_COLORS.length], points: pts, best: bestP && bestP[key] != null ? [bestP.timesteps, bestP[key]] : null, stop: r.early_stopping.stopped_early && last[key] != null ? [last.timesteps, last[key]] : null };
  });
  const xFmt = v => (v >= 1e6 ? `${(v / 1e6).toFixed(1)} M` : `${Math.round(v / 1000)} mil`);
  lineChart($('cleanChart'), { series: series('validation_clean_rate'), xFmt });
  const times = runs.flatMap(r => r.curves.evaluacion.map(p => p.validation_time_s)).filter(v => v != null);
  const lo = Math.floor(Math.min(...times, rules.mean_time_s_success) - 2), hi = Math.ceil(Math.max(...times, rules.mean_time_s_success) + 2);
  lineChart($('timeChart'), { series: series('validation_time_s'), yMin: lo, yMax: hi, yFmt: v => `${v.toFixed(0)} s`, xFmt, refs: [{ y: rules.mean_time_s_success, label: `maestro en el examen: ${secs(rules.mean_time_s_success)}` }] });
  const maxRound = Math.max(...runs.map(r => r.imitation.curve.length - 1));
  lineChart($('imitationChart'), {
    series: runs.map((r, i) => ({ name: `semilla ${r.seed}`, color: SEED_COLORS[i % SEED_COLORS.length], points: r.imitation.curve.map(p => [p.round, p.validation_success_rate]),
      best: [r.imitation.best_round, r.imitation.curve[r.imitation.best_round].validation_success_rate], stop: r.imitation.stopped_early ? [r.imitation.curve.at(-1).round, r.imitation.curve.at(-1).validation_success_rate] : null })),
    xFmt: v => `ronda ${Math.round(v)}`, xTicks: [0, Math.round(maxRound / 2), maxRound], refs: [{ y: rules.success_rate, label: `maestro en el examen: ${pct(rules.success_rate)}` }],
  });

  const rw = data.config.reward, mix = pc.env_mix, mixTotal = Object.values(mix).reduce((a, b) => a + b, 0);
  $('explainGrid').innerHTML = [
    ['1. Clase con el maestro', `Las reglas manejan y la red copia (DAgger). Hasta ${ic.max_rounds} rondas de ${ic.episodes_per_round} carreras; si pasan ${ic.patience_rounds} rondas sin mejorar, se detiene y se queda con la mejor.`],
    ['2. Calentamiento', `Los primeros ${big(pc.critic_warmup_steps)} pasos solo aprende el crítico (la parte que estima «qué tan bien voy»). El que maneja queda quieto para no dañar lo copiado.`],
    ['3. Práctica propia (PPO)', `${mixTotal} coches a la vez: ${mix.normal} con buen clima, ${mix.lluvia} con lluvia y ${mix.sensor_ruidoso} con sensores con ruido. Hasta ${big(pc.total_timesteps)} de pasos.`],
    ['4. Examen cada cierto tiempo', `Cada ${big(pc.eval_every_steps)} pasos maneja sin explorar en ${data.config.training.validation_episodes} pistas de validación (distintas a las del examen final). Se guarda el mejor: primero vueltas limpias, luego completas, luego tiempo.`],
    ['5. Parada temprana', `Después de ${big(pc.min_timesteps)} pasos, si lleva ${pc.patience_evals} exámenes seguidos sin mejorar, se detiene. Así no gasta pasos ni «olvida» lo aprendido por entrenar de más.`],
    ['6. Corte de episodios', `En el entrenamiento una carrera se corta a los ${pc.episode_cut_steps * data.config.physics.dt_s} s (${pc.episode_cut_steps} pasos): una vuelta buena toma unos 70 s. Además termina con 5 accidentes o 10 s sin avanzar.`],
    ['Recompensa v8', `+${rw.per_meter} por metro, +${rw.checkpoint} por checkpoint, +${rw.finish} al llegar. Cada paso cuesta ${Math.abs(rw.step)} (antes 0,02: ahora el tiempo importa) y cada accidente ${Math.abs(rw.accident)} (antes 5).`],
  ].map(([h, t]) => `<div><b>${h}</b>${t}</div>`).join('');
}

// ---------- pestaña Modelos y versiones ----------
function fillCatalog() {
  if (!catalog) { $('tab-modelos').innerHTML = '<p class="note">No se encontró catalogo.json. Ejecuta: python build_catalog.py</p>'; return; }
  const t = catalog.totals, stat = (label, value, small) => `<div class="stat"><span>${label}</span><b>${value}</b><small>${small}</small></div>`;
  $('catalogStats').innerHTML = [
    stat('Experimentos', `${t.experiments} de ${t.planned}`, `${t.tags} versiones etiquetadas en Git`),
    stat('Modelos entrenados', int(t.models), 'cada uno con su semilla, su configuración y su huella SHA-256'),
    stat('Episodios en total', `≈ ${int(Math.round(t.episodes / 1000) * 1000)}`, `${int(t.episodes_exact)} contados uno por uno; el resto, estimado`),
    stat('Pasos en total', big(t.steps), `≈ ${int(t.steps * 0.25 / 3600)} horas de manejo si cada paso durara 0,25 s`),
  ].join('');
  const hyp = h => `<span class="pill ${/^Sí/.test(h) ? 'ok' : /^No/.test(h) ? 'bad' : 'approx'}">${h}</span>`;
  $('catalogTable').tBodies[0].replaceChildren(...catalog.experiments.map(e => {
    const tr = document.createElement('tr'); if (e.id === 'N8') tr.className = 'best';
    tr.innerHTML = `<td><a href="${e.page}"><b>${e.id}</b></a><br><code>${e.tag}</code><br><small class="approx">${e.date}</small></td><td><b>${e.title}</b><br><small class="approx">${e.tested}</small></td><td>${e.model_type}</td>
      <td class="num">${e.models}</td><td class="num">${e.episodes_exact ? '' : '≈ '}${int(e.episodes)}</td><td class="num">${e.steps == null ? '—' : big(e.steps)}</td><td>${e.best}</td><td>${hyp(e.hypothesis)}</td>`;
    return tr;
  }), (() => { const tr = document.createElement('tr'); tr.className = 'total'; tr.innerHTML = `<td>Total</td><td>${t.experiments} experimentos</td><td>3 tipos de modelo + reglas</td><td class="num">${t.models}</td><td class="num">≈ ${int(t.episodes)}</td><td class="num">${big(t.steps)}</td><td></td><td></td>`; return tr; })());
  $('catalogNote').textContent = `Episodios: ${catalog.notes.episodes} Pasos: ${catalog.notes.steps}`;
  $('versionTable').tBodies[0].replaceChildren(...catalog.versioning.map(v => { const tr = document.createElement('tr'); tr.innerHTML = `<td><b>${v.what}</b></td><td>${v.where}</td><td>${v.how}</td>`; return tr; }));
  $('modelTypes').tBodies[0].replaceChildren(...catalog.model_types.map(m => { const tr = document.createElement('tr'); tr.innerHTML = `<td><b>${m.name}</b></td><td>${m.what}</td><td>${m.where}</td><td>${m.why}</td><td>${m.limit}</td>`; return tr; }));
}

// ---------- pestaña Qué es cada cosa ----------
function fillGlossary() {
  const c = data.config, pc = c.training.ppo, rw = c.reward, ep = c.episode, dt = c.physics.dt_s, s = c.sensors;
  const nCells = c.track.lanes * s.lookahead_cells * s.features_per_cell.length, nCourse = s.course_times_s.length * 3, nObs = s.base_features + nCourse + nCells;
  const g = items => items.map(([h, t]) => `<div><b>${h}</b>${t}</div>`).join('');
  $('glossTerms').innerHTML = g([
    ['Paso', `Una decisión de la IA: mira los sensores y elige pedal y volante. Vale <em>${dt} s</em> de carrera (${1 / dt} decisiones por segundo). Es la unidad en que se mide cuánto se entrenó.`],
    ['Episodio', `Una carrera completa, desde la salida hasta que termina. No dura siempre lo mismo: una vuelta limpia son unos 280 pasos; un coche que choca 5 veces al inicio dura 30. Por eso <em>pasos = episodios × duración media</em>.`],
    ['Cómo termina un episodio', `<ul><li>Llega a la meta.</li><li>Acumula ${ep.max_accidents} accidentes.</li><li>Se atasca: ${ep.stall_steps * dt} s sin avanzar.</li><li>Límite: ${ep.max_steps} pasos (${ep.max_steps * dt} s).</li><li>Solo al entrenar: corte a los ${pc.episode_cut_steps} pasos.</li></ul>Los tres últimos son formas de <em>truncar</em>: cortar una carrera que ya no enseña nada.`],
    ['Parada temprana', `Dejar de entrenar cuando el modelo ya no mejora en pistas que no usa para aprender. Evita gastar cómputo y evita el sobreajuste. Aquí: ${pc.patience_evals} exámenes seguidos sin mejorar.`],
    ['Semilla', 'El número que fija el azar. Cada experimento se repite con 3 semillas (7, 21 y 42) para saber si el resultado es estable o fue suerte.'],
    ['Entrenamiento, validación y examen', `Tres grupos de pistas que no se mezclan: las de <em>entrenar</em> (nuevas en cada carrera), ${c.training.validation_episodes} de <em>validación</em> (para elegir el mejor punto y decidir cuándo parar) y ${c.training.evaluation_episodes} de <em>examen</em>, las mismas desde el N4.`],
    ['Política', 'La «forma de manejar» que aprendió el modelo: la función que convierte lo que ve en lo que hace.'],
    ['Exploración', 'Al entrenar, el modelo prueba acciones un poco distintas a las que cree mejores para descubrir si hay algo mejor. En los exámenes no explora.'],
  ]);
  $('glossVars').innerHTML = g([
    [`Lo que ve: ${nObs} números (observación)`, `<ul><li><em>${s.base_features}</em> del propio coche: velocidad, rumbo, posición en la pista, deslizamiento, peso en las ruedas, suspensión, combustible…</li><li><em>${nCourse}</em> de «mirada de piloto»: dónde queda la pista a ${s.course_times_s[0]}–${s.course_times_s.at(-1)} s adelante.</li><li><em>${nCells}</em> de obstáculos: ${s.lookahead_cells} celdas adelante × ${c.track.lanes} carriles × ${s.features_per_cell.length} rasgos (${s.features_per_cell.join(', ')}).</li></ul>`],
    ['Lo que hace: 2 números (acción)', 'Pedal de −1 (frenar a fondo) a +1 (acelerar a fondo) y volante de −1 (derecha) a +1 (izquierda). Son continuos: puede acelerar «un poco».'],
    ['Lo que se le premia (recompensa v8)', `<ul><li>+${rw.per_meter} por cada metro nuevo</li><li>+${rw.checkpoint} por checkpoint (cada ${c.track.checkpoint_every_m} m)</li><li>+${rw.finish} por llegar a la meta</li><li>${rw.step} por cada paso (el tiempo cuesta)</li><li>${rw.accident} por accidente</li><li>${rw.stalled} si se atasca</li></ul>`],
    ['Lo que mide el examen (métricas)', 'Vueltas completas, vueltas limpias (sin accidentes), tiempo de vuelta, accidentes por vuelta y velocidad al chocar; en tres condiciones: normal, lluvia y sensores con ruido.'],
    ['Lo que nosotros elegimos (hiperparámetros)', `<ul><li>Red: ${pc.net_arch.join(' × ')} neuronas</li><li>Tasa de aprendizaje: ${pc.learning_rate} (baja con el tiempo)</li><li>Recorte de PPO: ${pc.clip_range} (qué tanto puede cambiar por vez)</li><li>Descuento γ: ${pc.gamma} (cuánto pesa el futuro)</li><li>${Object.values(pc.env_mix).reduce((a, b) => a + b, 0)} coches a la vez × ${pc.n_steps} pasos por tanda</li><li>Paciencia: ${pc.patience_evals} exámenes</li></ul>`],
    ['Lo que NO cambia entre modelos', 'La física del coche, la pista, los sensores y las 30 pistas del examen. Así, si un modelo maneja mejor, es por cómo aprendió.'],
  ]);
}

function initTabs() {
  const tabs = [...document.querySelectorAll('.tabs button')];
  const show = name => { tabs.forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name))); document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== `tab-${name}`; }); };
  tabs.forEach(b => { b.onclick = () => { show(b.dataset.tab); history.replaceState(null, '', `#${b.dataset.tab}`); }; });
  const wanted = location.hash.slice(1); if (tabs.some(b => b.dataset.tab === wanted)) show(wanted);
}

function initFullscreen() {
  const world = $('world'), btn = $('fsBtn');
  if (!world.requestFullscreen) { btn.hidden = true; return; }
  btn.onclick = () => (document.fullscreenElement ? document.exitFullscreen() : world.requestFullscreen().catch(() => {}));
  document.addEventListener('fullscreenchange', () => { const on = document.fullscreenElement === world; btn.setAttribute('aria-pressed', String(on)); btn.textContent = on ? '✕ Salir de pantalla completa' : '⛶ Pantalla completa'; });
  world.addEventListener('dblclick', e => { if (e.target.tagName === 'CANVAS') btn.click(); });
  window.addEventListener('keydown', e => { if (e.key === 'f' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName ?? '')) btn.click(); });
}

try {
  initTabs(); initFullscreen();
  const res = await fetch('v8-results.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('No están las corridas v8. Ejecuta: python pipeline_v8.py');
  data = await res.json();
  try { const r = await fetch('catalogo.json', { cache: 'no-store' }); if (r.ok) catalog = await r.json(); } catch { catalog = null; }
  window.rallyV8Data = data;
  scenarios = data.scenarios;
  $('replaySelect').replaceChildren(...scenarios.map((s, i) => new Option(s.label, String(i))));
  $('replaySelect').disabled = $('toggle').disabled = false;
  for (const fill of [fillSummary, fillTraining, fillCatalog, fillGlossary]) { try { fill(); } catch (err) { console.error(fill.name, err); } }
  revealOnScroll();
  const params = new URLSearchParams(location.search);
  let wanted = scenarios.findIndex(s => s.id === params.get('escenario'));
  if (wanted < 0) wanted = 0;
  window.rallyV8Scenario = null;
  await import('./scene-v8.js');
  startScenario(wanted);
  $('loadStatus').textContent = 'Carreras reales calculadas por Python (física cada 0,025 s). Ninguna de estas pistas se usó para entrenar. Atajo: tecla F o doble clic en la imagen para pantalla completa.';
  $('replaySelect').onchange = () => startScenario(Number($('replaySelect').value));
  $('toggle').onclick = () => { playing = !playing; $('toggle').textContent = playing ? 'Pausar' : 'Reanudar'; window.dispatchEvent(new CustomEvent('rally8:control', { detail: { paused: !playing } })); };
  $('reset').onclick = () => startScenario(selected);
  $('speed').onchange = () => { stepMs = Number($('speed').value); startScenario(selected); };
  $('quality').onchange = () => window.dispatchEvent(new CustomEvent('rally8:quality', { detail: $('quality').value }));
  $('exaggerate').onchange = () => window.dispatchEvent(new CustomEvent('rally8:exaggerate', { detail: $('exaggerate').checked ? 3 : 1 }));
  $('timeOfDay').onchange = () => { const v = $('timeOfDay').value; window.dispatchEvent(new CustomEvent('rally8:time', { detail: v })); try { localStorage.setItem('rally-hora', v); } catch {} };
  try { const v = new URLSearchParams(location.search).get('hora') || localStorage.getItem('rally-hora'); if (v && $('timeOfDay').querySelector(`option[value="${v}"]`)) { $('timeOfDay').value = v; setTimeout(() => window.dispatchEvent(new CustomEvent('rally8:time', { detail: v })), 0); } } catch {}
  // Sonido: botón para activarlo (el navegador lo exige) y dos volúmenes, motores y estadio.
  const snd = window.rallyV8Sound;
  try { const v = JSON.parse(localStorage.getItem('rally-sonido') || '{}'); if (v.engine != null) $('volEngine').value = Math.round(v.engine * 100); if (v.crowd != null) $('volCrowd').value = Math.round(v.crowd * 100); } catch {}
  $('soundBtn').onclick = () => {
    const on = $('soundBtn').getAttribute('aria-pressed') !== 'true';
    $('soundBtn').setAttribute('aria-pressed', String(on)); $('soundBtn').textContent = on ? '🔊 Sonido activado' : '🔇 Activar sonido';
    window.dispatchEvent(new CustomEvent('rally8:sound', { detail: { on, engine: $('volEngine').value / 100, crowd: $('volCrowd').value / 100 } }));
  };
  $('volEngine').oninput = () => window.dispatchEvent(new CustomEvent('rally8:sound', { detail: { engine: $('volEngine').value / 100 } }));
  $('volCrowd').oninput = () => window.dispatchEvent(new CustomEvent('rally8:sound', { detail: { crowd: $('volCrowd').value / 100 } }));
  $('trailToggle').onchange = () => window.dispatchEvent(new CustomEvent('rally8:trails', { detail: $('trailToggle').checked }));
  $('lookToggle').onchange = () => window.dispatchEvent(new CustomEvent('rally8:look', { detail: $('lookToggle').checked }));
} catch (error) {
  console.error(error);
  $('loadStatus').textContent = error.message;
  $('sceneStatus').textContent = 'No se pudo cargar la reproducción v8.';
}
