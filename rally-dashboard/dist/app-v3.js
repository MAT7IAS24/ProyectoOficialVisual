// Reproducción del experimento 3 (N3). Todo lo que se ve sale de v3-results.json,
// que escribe pipeline_v3.py. Aquí NO hay un segundo simulador ni se entrena nada.
import { TERRAIN_COLORS } from './track-v3.js';

const $ = id => document.getElementById(id);
const signed = (n, d = 2) => `${n >= 0 ? '+' : ''}${Number(n).toFixed(d)}`;
const pct = n => `${(n * 100).toFixed(0)}%`;
let data, run, scenarios = [], selected = 0, frameIndex = 0, timer, playing = true, toastTimer;

const ACTION_LABELS = { frenar: 'Frenar', mantener: 'Mantener', acelerar: 'Acelerar', carril_izquierda: '← Carril', carril_derecha: 'Carril →' };
const TERRAIN_LABELS = { asfalto: 'Tierra lisa', lodo: 'Lodo', agua: 'Agua', sin_pista: 'Sin pista (pasto)', foso: 'Foso', barril: 'Barril', rampa: 'Rampa', rampa_con_barril: 'Rampa con barril', puente: 'Puente', puente_roto: 'Hueco del puente', meta: 'Meta' };
const EVENT_LABELS = {
  cambio_de_carril: 'Cambia de carril', cambio_de_carril_bloqueado_en_puente: 'Sobre el puente no puede cambiar de carril',
  cambio_de_carril_bloqueado_por_muro: 'Muro: no hay más carriles', derrape_al_cambiar_de_carril: 'Derrapa al cambiar de carril muy rápido',
  frenado_por_lodo: 'El lodo lo frena', frenado_por_sin_pista: 'Sin pista: el pasto lo frena', derrape_en_agua: 'Derrapa en el agua',
  cae_en_foso: 'Cae en el foso', choca_con_barril: 'Choca con un barril', choca_con_el_barril_de_la_rampa: 'Choca con el barril de la rampa',
  sube_despacio_la_rampa: 'Sube la rampa despacio (no salta)', salta_la_rampa: '¡Salta la rampa!', aterriza_en_el_puente: 'Aterriza en el puente',
  baja_del_puente: 'Baja del puente', cae_del_puente: 'Cae por el hueco del puente', cruza_el_hueco_del_puente: 'Vuela sobre el hueco del puente',
};
const CAUSE_LABELS = { en_curso: 'EN CARRERA', vuelta_completada: 'VUELTA COMPLETA', demasiados_accidentes: 'DEMASIADOS ACCIDENTES', sin_combustible: 'SIN COMBUSTIBLE', limite_pasos: 'LÍMITE DE PASOS' };
const MODE_LABELS = {
  evaluation: 'EVALUACIÓN · política congelada, sin exploración',
  training: 'ENTRENAMIENTO · muestra registrada (el agente todavía explora)',
  baseline: 'REFERENCIA · política de reglas escritas a mano (no aprende)',
  incident: 'INCIDENTE · lluvia con el modelo original',
  intervention: 'INTERVENCIÓN · modelo reentrenado',
};

// ---------- Mapa 2D de carriles (siempre visible; también es la vista de respaldo) ----------
function drawLaneMap(frame) {
  const canvas = $('laneMap'), ctx = canvas.getContext('2d');
  const env = data.config.environment, layout = data.layouts[scenarios[selected].layout];
  const N = env.track_length_meters / env.segment_meters, lanes = env.lanes;
  const padL = 190, padT = 16, cw = (canvas.width - padL - 16) / N, ch = (canvas.height - padT - 26) / lanes;
  const byCode = Object.fromEntries(env.terrains.map(t => [t.code, t]));
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#8cc63f'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '700 14px system-ui'; ctx.textBaseline = 'middle';
  layout.forEach((row, lane) => {
    const y = padT + lane * ch;
    ctx.fillStyle = '#16222b'; ctx.fillText(row.name, 8, y + ch / 2);
    for (let i = 0; i < N; i++) {
      const t = byCode[row.ground[i]], x = padL + i * cw;
      ctx.fillStyle = TERRAIN_COLORS[t.name]; ctx.fillRect(x, y + 2, cw - 1, ch - 4);
      if (t.name === 'barril' || t.name === 'rampa_con_barril') { ctx.fillStyle = '#d8332a'; ctx.beginPath(); ctx.arc(x + cw / 2, y + ch / 2, Math.min(cw, ch) * 0.22, 0, 7); ctx.fill(); }
      if (t.kind === 'ramp') { ctx.fillStyle = '#f2b48b'; ctx.beginPath(); ctx.moveTo(x + 3, y + ch - 5); ctx.lineTo(x + cw - 6, y + 6); ctx.lineTo(x + cw - 6, y + ch - 5); ctx.fill(); }
      const deck = row.deck[i];
      if (deck !== '-') { ctx.fillStyle = deck === 'P' ? '#f2b48b' : '#17110e'; ctx.fillRect(x, y + 2, cw - 1, 9); ctx.strokeStyle = '#7a4a2e'; ctx.strokeRect(x + 0.5, y + 2.5, cw - 2, 8); }
    }
  });
  ctx.fillStyle = '#16222b'; ctx.font = '600 12px system-ui';
  for (let i = 0; i <= N; i += 5) ctx.fillText(`${i * env.segment_meters} m`, padL + i * cw - 12, canvas.height - 10);
  // meta a cuadros
  for (let k = 0; k < lanes * 4; k++) { ctx.fillStyle = k % 2 ? '#111' : '#fff'; ctx.fillRect(padL + N * cw - 2, padT + k * ch / 4, 6, ch / 4); }
  if (!frame) return;
  const x = padL + Math.min(frame.segment + 0.5, N) * cw, y = padT + frame.lane * ch + ch / 2 - (frame.layer ? ch * 0.3 : 0);
  ctx.fillStyle = '#ffc320'; ctx.strokeStyle = '#111'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.roundRect(x - 13, y - 9, 26, 18, 4); ctx.fill(); ctx.stroke(); ctx.lineWidth = 1;
}

function legend() {
  const used = new Set();
  for (const l of Object.values(data.layouts)) for (const row of l) for (const c of row.ground + row.deck) if (c !== '-') used.add(c);
  $('terrainLegend').replaceChildren(...data.config.environment.terrains.filter(t => used.has(t.code)).map(t => {
    const s = document.createElement('span'); const b = document.createElement('b');
    b.style.background = t.name.includes('barril') ? '#d8332a' : t.kind === 'ramp' ? '#f2b48b' : TERRAIN_COLORS[t.name]; s.append(b, TERRAIN_LABELS[t.name]); return s;
  }));
}

// ---------- Reproducción ----------
function toast(text) {
  const el = $('eventToast'); el.textContent = text; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

function render() {
  const sc = scenarios[selected], frame = sc.frames[frameIndex], prev = sc.frames[Math.max(0, frameIndex - 1)];
  const env = data.config.environment;
  $('modeBanner').dataset.mode = sc.mode; $('modeBanner').textContent = sc.mode === 'intervention' ? `INTERVENCIÓN · ${sc.label.replace(/^Intervención /, '')}` : MODE_LABELS[sc.mode];
  $('layoutName').textContent = sc.layout === 'lluvia' ? 'Con lluvia (perturbación)' : 'Condiciones normales';
  $('episode').textContent = sc.episode;
  $('progress').firstChild.textContent = frame.progress_pct.toFixed(0);
  $('progressBar').style.width = `${frame.progress_pct}%`;
  $('distance').textContent = `${frame.position_meters} m de ${env.track_length_meters} m`;
  $('step').firstChild.textContent = `${frame.steps} `;
  $('step').querySelector('small').textContent = `/ ${env.max_steps}`;
  $('action').textContent = frame.action === null ? 'INICIO' : ACTION_LABELS[env.actions[frame.action].name];
  $('reward').textContent = signed(frame.reward);
  $('return').textContent = signed(frame.return);
  $('trackScore').textContent = `PUNTOS ${signed(frame.return, 1)}`;
  $('lane').textContent = `${frame.lane + 1} / ${env.lanes}`;
  $('layer').textContent = frame.layer ? 'Sobre el puente' : 'Suelo';
  $('speedLevel').textContent = `${frame.speed_level} / ${env.max_speed_level}`;
  $('fuel').textContent = frame.fuel.toFixed(0);
  $('here').textContent = TERRAIN_LABELS[frame.terrain_here] ?? frame.terrain_here;
  $('ahead').textContent = TERRAIN_LABELS[frame.terrain_ahead] ?? frame.terrain_ahead;
  $('accidents').textContent = `${frame.accidents} / ${env.max_accidents}`;
  const said = frame.events.map(e => EVENT_LABELS[e] ?? e);
  $('events').textContent = said.length ? said.join(' · ') : '—';
  $('status').textContent = CAUSE_LABELS[frame.termination_cause] ?? frame.termination_cause;
  $('stateLabel').textContent = `s = (${(frame.decision_observation ?? frame.observation).join(', ')})`;
  const q = frame.q_values;
  if (q) {
    const best = q.indexOf(Math.max(...q));
    $('qRows').replaceChildren(...env.actions.map((a, i) => {
      const row = document.createElement('div'); row.className = `q-row${i === best ? ' best' : ''}`;
      row.innerHTML = `<span>${ACTION_LABELS[a.name]}</span><b>${signed(q[i], 2)}</b>`; return row;
    }));
  } else {
    $('qRows').innerHTML = '<div class="q-row"><span>Esta política no usa tabla Q (reglas fijas)</span></div>';
  }
  if (frameIndex > 0 && said.length) toast(said[said.length - 1]);
  if (frameIndex > 0 && frame.termination_cause !== 'en_curso') toast(CAUSE_LABELS[frame.termination_cause]);
  drawLaneMap(frame);
  const detail = {
    key: `${run.seed}:${selected}`, step: frame.steps, duration: Number($('speed').value),
    from: frameIndex === 0 ? frame : prev, to: frame, jump: frame.jump, crash_segment: frame.crash_segment,
    layout: data.layouts[sc.layout],
  };
  window.rallyV3Frame = detail;
  window.dispatchEvent(new CustomEvent('rally3:frame', { detail }));
  $('loadStatus').textContent = `${sc.label} · semilla ${run.seed}. Datos reales registrados por Python; esto es una reproducción, no un entrenamiento en vivo.`;
}

function schedule() { clearTimeout(timer); if (playing) timer = setTimeout(tick, Number($('speed').value)); }
function tick() {
  if (!playing) return;
  if (frameIndex < scenarios[selected].frames.length - 1) frameIndex++;
  else { frameIndex = 0; }
  render(); schedule();
}
function pick(i) { selected = i; frameIndex = 0; $('replaySelect').value = String(i); render(); schedule(); }

function selectSeed() {
  clearTimeout(timer);
  run = data.runs.find(r => String(r.seed) === $('seedSelect').value);
  scenarios = run.scenarios;
  $('replaySelect').replaceChildren(...scenarios.map((s, i) => new Option(s.label, String(i))));
  const m = run.metadata.evaluation;
  $('seedSummary').textContent = `Semilla ${run.seed}: ${data.config.training.episodes} episodios de entrenamiento. Evaluación (${data.config.training.evaluation_episodes} episodios): ${pct(m.success_rate)} de vueltas completas, retorno medio ${m.mean_return.toFixed(1)}. Modelo ${run.experiment_id}${run.mlflow_run_id ? ` · MLflow ${run.mlflow_run_id}` : ''}.`;
  pick(0);
}

function fillComparison() {
  const rows = [];
  const add = (name, cond, s, best = false) => rows.push({ name, cond, s, best });
  add('Aleatoria', 'Normal', data.baselines.aleatoria);
  add('Reglas (a mano)', 'Normal', data.baselines.reglas);
  const mean = Object.fromEntries(Object.entries(data.between_seed_evaluation).map(([k, v]) => [k, v.mean]));
  add('Q-learning', 'Normal', mean, true);
  if (data.incident) {
    add('Q-learning original', 'Lluvia', data.incident.degraded);
    for (const [key, opt] of Object.entries(data.incident.interventions)) {
      const name = key === 'solo_lluvia' ? 'Intervención A · solo lluvia' : 'Intervención B · clima mixto';
      add(name, 'Lluvia', opt.under_rain, opt.accepted);
      add(name, 'Normal', opt.under_normal, opt.accepted);
    }
  }
  $('compareTable').tBodies[0].replaceChildren(...rows.map(r => {
    const tr = document.createElement('tr'); if (r.best) tr.className = 'best';
    tr.innerHTML = `<td>${r.name}</td><td>${r.cond}</td><td>${pct(r.s.success_rate)}</td><td>${signed(r.s.mean_return, 1)}</td><td>${r.s.mean_steps.toFixed(1)}</td><td>${r.s.mean_accidents.toFixed(2)}</td>`;
    return tr;
  }));
  const sel = data.selection;
  $('selection').textContent = sel.accepted ? `CANDIDATO ACEPTADO · ${pct(sel.mean_success_rate)} éxito · +${sel.return_margin_over_rules.toFixed(1)} sobre reglas` : 'CANDIDATO RECHAZADO';
  $('selection').className = sel.accepted ? 'ok' : 'bad';
  $('hypothesis').textContent = `Hipótesis: ${data.config.experiment.hypothesis} Criterio fijado antes de entrenar: éxito ≥ ${pct(sel.criteria.min_success_rate)} y al menos ${sel.criteria.min_return_margin_over_rules} puntos más que la política de reglas.`;
  if (data.incident) {
    const inc = data.incident, opts = Object.values(inc.interventions);
    $('incidentNote').textContent = `Incidente controlado · ${inc.description} Antes: ${pct(inc.before.success_rate)} de vueltas completas. Con lluvia y el modelo original: ${pct(inc.degraded.success_rate)}. ${inc.rule} ` +
      opts.map(o => `${o.label}: ${o.accepted ? 'ACEPTADA' : 'RECHAZADA'} (${o.reason}).`).join(' ') + ` Decisión: ${inc.decision}.`;
  }
  if (data.tracking && data.tracking.startsWith('omitido')) $('incidentNote').textContent += ' Nota: estos datos se generaron sin DVC ni MLflow (prueba). La corrida oficial se registra con pipeline_v3.py sin --skip-tracking.';
}

try {
  const response = await fetch('v3-results.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('No están las corridas v3. Ejecuta: python pipeline_v3.py');
  data = await response.json();
  window.rallyV3Config = data.config;
  window.rallyV3Layout = data.layouts.normal;
  const r = data.config.reward;
  $('rewardRule').textContent = `Recompensa: ${r.step} por paso · +${r.new_segment} por cada tramo nuevo avanzado · ${r.fuel_unit} por unidad de combustible · ${r.accident} por accidente · +${r.finish} al llegar a la meta y +${r.remaining_fuel_unit} por unidad de combustible sobrante.`;
  legend();
  fillComparison();
  $('seedSelect').replaceChildren(...data.runs.map(x => new Option(String(x.seed), String(x.seed))));
  $('seedSelect').disabled = $('replaySelect').disabled = $('toggle').disabled = false;
  // Enlace directo: v3.html?seed=21&escenario=B-lluvia&paso=5
  const params = new URLSearchParams(location.search);
  if (params.has('seed') && data.runs.some(x => String(x.seed) === params.get('seed'))) $('seedSelect').value = params.get('seed');
  selectSeed();
  const wanted = scenarios.findIndex(x => x.id === params.get('escenario'));
  if (wanted >= 0) pick(wanted);
  if (params.has('paso')) { frameIndex = Math.min(Number(params.get('paso')) || 0, scenarios[selected].frames.length - 1); if (params.get('pausa') !== null) { playing = false; $('toggle').textContent = 'Reanudar reproducción'; } render(); }
  await import('./scene-v3.js');
  render();
  $('seedSelect').onchange = selectSeed;
  $('replaySelect').onchange = () => pick(Number($('replaySelect').value));
  $('toggle').onclick = () => { playing = !playing; $('toggle').textContent = playing ? 'Pausar reproducción' : 'Reanudar reproducción'; schedule(); };
  $('reset').onclick = () => { frameIndex = 0; render(); schedule(); };
  $('speed').oninput = schedule;
} catch (error) {
  clearTimeout(timer);
  console.error(error);
  $('loadStatus').textContent = error.message;
  $('sceneStatus').textContent = 'No se pudo cargar la reproducción v3. Los experimentos 1 y 2 siguen disponibles.';
  $('toggle').disabled = true;
}
