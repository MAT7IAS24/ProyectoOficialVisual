// Reproducción y gráficas del experimento 4. Python genera todos los datos.
import { TERRAIN_COLORS_V4 as TERRAIN_COLORS } from './track-v3.js';

const $ = id => document.getElementById(id);
const signed = (n, d = 2) => `${n >= 0 ? '+' : ''}${Number(n).toFixed(d)}`;
const pct = n => `${(n * 100).toFixed(0)}%`;
let data, run, scenarios = [], selected = 0, frameIndex = 0, timer, playing = true, toastTimer, laneAnimationFrame;

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
  incident: 'EVALUACIÓN · clima lluvioso',
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

function animateLaneMarker(from, to, duration) {
  cancelAnimationFrame(laneAnimationFrame);
  if (!from || !to || from.segment === to.segment && from.lane === to.lane || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const started = performance.now(), span = Math.max(80, duration * 0.82);
  const step = now => {
    const t = Math.min(1, (now - started) / span);
    const eased = t * t * (3 - 2 * t);
    drawLaneMap({
      ...to,
      segment: from.segment + (to.segment - from.segment) * eased,
      lane: from.lane + (to.lane - from.lane) * eased,
      layer: t < 0.5 ? from.layer : to.layer,
    });
    if (t < 1) laneAnimationFrame = requestAnimationFrame(step);
  };
  laneAnimationFrame = requestAnimationFrame(step);
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
  $('weatherIndicator').textContent = sc.layout === 'lluvia' ? 'LLUVIA · PISTA MOJADA' : 'CLIMA SECO';
  $('weatherIndicator').dataset.weather = sc.layout === 'lluvia' ? 'rain' : 'dry';
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
  $('trackScore').dataset.impact = frame.accidents_now > 0 ? 'true' : 'false';
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
  animateLaneMarker(frameIndex === 0 ? frame : prev, frame, Number($('speed').value));
  const detail = {
    key: `${run.seed}:${selected}`, step: frame.steps, duration: Number($('speed').value),
    from: frameIndex === 0 ? frame : prev, to: frame, jump: frame.jump, crash_segment: frame.crash_segment,
    gapCrossings: frame.gap_crossings ?? (frame.events.includes('cruza_el_hueco_del_puente')
      ? frame.path.filter(point => point.layer === 1 && data.layouts[sc.layout][frame.lane].deck[point.segment] === 'G').map(point => ({ segment: point.segment }))
      : []),
    layout: data.layouts[sc.layout],
    weather: frame.weather ?? sc.layout,
    actionName: frame.action === null ? null : env.actions[frame.action].name,
    events: frame.events,
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
  const rain = run.metadata.evaluation_lluvia;
  $('seedSummary').textContent = `Semilla ${run.seed}: ${data.config.training.episodes} episodios con clima mixto. Evaluación normal: ${pct(m.success_rate)} éxito, retorno ${m.mean_return.toFixed(1)}; lluvia: ${pct(rain.success_rate)}, retorno ${rain.mean_return.toFixed(1)}. Estados Q visitados: ${run.metadata.stored_state_count.toLocaleString()}. Modelo ${run.experiment_id}${run.mlflow_run_id ? ` · MLflow ${run.mlflow_run_id}` : ''}.`;
  renderCharts();
  pick(0);
}

function movingAverage(values, windowSize = 100) {
  let sum = 0;
  return values.map((value, index) => {
    sum += value;
    if (index >= windowSize) sum -= values[index - windowSize];
    return sum / Math.min(index + 1, windowSize);
  });
}

function drawChart(id, rawValues, values, color, label, percent = false) {
  const host = $(id);
  const width = 720, height = 250, left = 54, right = 18, top = 14, bottom = 34;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const samples = values.filter(Number.isFinite);
  const raw = rawValues.filter(Number.isFinite);
  if (!samples.length) {
    host.textContent = 'Sin métricas para graficar.';
    return;
  }
  const low = percent ? 0 : Math.min(...samples, ...raw);
  const high = percent ? 1 : Math.max(...samples, ...raw);
  const padding = percent ? 0 : Math.max((high - low) * 0.1, Math.abs(high) * 0.02, 0.1);
  const min = percent ? 0 : low - padding;
  const max = percent ? 1 : high + padding;
  const range = max - min || 1;
  const count = Math.min(samples.length, 240);
  const makePoints = (series, limit = count) => {
    const pointCount = Math.min(series.length, limit);
    return Array.from({ length: pointCount }, (_, index) => {
      const sourceIndex = Math.round(index * (series.length - 1) / Math.max(1, pointCount - 1));
      const x = left + index * plotWidth / Math.max(1, pointCount - 1);
      const y = top + (max - series[sourceIndex]) / range * plotHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('aria-label', `${label}; ${samples.length} episodios, media móvil final ${samples[samples.length - 1].toFixed(2)}`);
  const title = document.createElementNS(svg.namespaceURI, 'title');
  title.textContent = `${label}: datos por episodio y media móvil de 100 episodios`;
  svg.append(title);
  for (let tick = 0; tick <= 4; tick++) {
    const y = top + tick * plotHeight / 4;
    const line = document.createElementNS(svg.namespaceURI, 'line');
    line.setAttribute('x1', left); line.setAttribute('x2', width - right);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('class', 'chart-gridline'); svg.append(line);
    const text = document.createElementNS(svg.namespaceURI, 'text');
    text.setAttribute('x', left - 8); text.setAttribute('y', y + 4);
    text.setAttribute('text-anchor', 'end'); text.setAttribute('class', 'chart-axis');
    text.textContent = percent ? `${Math.round((1 - tick / 4) * 100)}%` : (max - tick * range / 4).toFixed(1);
    svg.append(text);
  }
  const rawLine = document.createElementNS(svg.namespaceURI, 'polyline');
  rawLine.setAttribute('points', makePoints(raw, raw.length)); rawLine.setAttribute('fill', 'none');
  rawLine.setAttribute('stroke', color); rawLine.setAttribute('stroke-width', '1');
  rawLine.setAttribute('stroke-opacity', '0.25'); rawLine.setAttribute('stroke-linejoin', 'round');
  svg.append(rawLine);
  const path = document.createElementNS(svg.namespaceURI, 'polyline');
  path.setAttribute('points', makePoints(samples)); path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color); path.setAttribute('stroke-width', '3.5');
  path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  const xStart = document.createElementNS(svg.namespaceURI, 'text');
  xStart.setAttribute('x', left); xStart.setAttribute('y', height - 8);
  xStart.setAttribute('class', 'chart-axis'); xStart.textContent = 'Ep. 1'; svg.append(xStart);
  const xMiddle = document.createElementNS(svg.namespaceURI, 'text');
  xMiddle.setAttribute('x', left + plotWidth / 2); xMiddle.setAttribute('y', height - 8);
  xMiddle.setAttribute('text-anchor', 'middle'); xMiddle.setAttribute('class', 'chart-axis');
  xMiddle.textContent = `Ep. ${Math.ceil(samples.length / 2)}`; svg.append(xMiddle);
  const xEnd = document.createElementNS(svg.namespaceURI, 'text');
  xEnd.setAttribute('x', width - right); xEnd.setAttribute('y', height - 8);
  xEnd.setAttribute('text-anchor', 'end'); xEnd.setAttribute('class', 'chart-axis');
  xEnd.textContent = `Ep. ${samples.length}`; svg.append(xEnd);
  host.replaceChildren(svg);
}

function renderCharts() {
  const metrics = run.training_metrics ?? [];
  const windowSize = data.config.training.summary_window ?? 100;
  const average = values => movingAverage(values, windowSize);
  $('chartSeed').textContent = `Semilla ${run.seed} · clima mixto`;
  drawChart('returnChart', metrics.map(item => item.return), average(metrics.map(item => item.return)), '#ffd12e', 'Retorno medio móvil');
  drawChart('successChart', metrics.map(item => item.success), average(metrics.map(item => item.success)), '#47df9a', 'Éxito medio móvil', true);
  drawChart('accidentChart', metrics.map(item => item.accidents), average(metrics.map(item => item.accidents)), '#ff8a7a', 'Accidentes medios móviles');
  drawChart('tdChart', metrics.map(item => item.mean_abs_td_error), average(metrics.map(item => item.mean_abs_td_error)), '#70c4fa', 'Error TD absoluto medio móvil');
}

function fillComparison() {
  const rows = [];
  const add = (name, cond, s, best = false) => rows.push({ name, cond, s, best });
  for (const weather of ['normal', 'lluvia']) {
    const label = weather === 'normal' ? 'Normal' : 'Lluvia';
    const learned = data.evaluation[weather];
    add('Q-learning v4', label, learned, true);
    add('Reglas (a mano)', label, data.baselines[weather].reglas);
    add('Aleatoria', label, data.baselines[weather].aleatoria);
  }
  $('compareTable').tBodies[0].replaceChildren(...rows.map(r => {
    const tr = document.createElement('tr'); if (r.best) tr.className = 'best';
    tr.innerHTML = `<td>${r.name}</td><td>${r.cond}</td><td>${pct(r.s.success_rate)}</td><td>${signed(r.s.mean_return, 1)}</td><td>${r.s.mean_steps.toFixed(1)}</td><td>${r.s.mean_accidents.toFixed(2)}</td>`;
    return tr;
  }));
  const sel = data.selection;
  $('selection').textContent = sel.accepted
    ? `CRITERIOS CUMPLIDOS · normal ${pct(sel.normal_success_rate)} · lluvia ${pct(sel.rain_success_rate)}`
    : `CRITERIOS NO CUMPLIDOS · normal ${pct(sel.normal_success_rate)} · lluvia ${pct(sel.rain_success_rate)}`;
  $('selection').className = sel.accepted ? 'ok' : 'bad';
  $('hypothesis').textContent = `Hipótesis: ${data.config.experiment.hypothesis} Criterios fijados antes de entrenar: éxito ≥ ${pct(sel.criteria.min_success_rate_normal)} en pista normal y ≥ ${pct(sel.criteria.min_success_rate_rain)} bajo lluvia.`;
  $('incidentNote').textContent = 'Comparación con políticas aleatoria y de reglas sobre la misma suite de evaluación. Las tres semillas se entrenan con una mezcla 50/50 de clima normal y lluvia.';
  if (data.tracking && data.tracking.startsWith('omitido')) $('incidentNote').textContent += ' Prueba sin DVC ni MLflow: no es una corrida oficial.';
}

try {
  const response = await fetch('v4-results.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Aún no hay resultados v4. Entrena con: python run_experiment.py --environment-version rally-v4');
  data = await response.json();
  window.rallyV3Config = data.config;
  window.rallyV3Layout = data.layouts.normal;
  window.rallySceneStyle = 'v4';
  const r = data.config.reward;
  $('rewardRule').textContent = `Recompensa: ${r.step} por paso · +${r.new_segment} por cada tramo nuevo avanzado · ${r.fuel_unit} por unidad de combustible · ${r.accident} por accidente · +${r.finish} al llegar a la meta y +${r.remaining_fuel_unit} por unidad de combustible sobrante.`;
  legend();
  fillComparison();
  $('seedSelect').replaceChildren(...data.runs.map(x => new Option(String(x.seed), String(x.seed))));
  $('seedSelect').disabled = $('replaySelect').disabled = $('toggle').disabled = false;
  // Enlace directo: v4.html?seed=21&escenario=rain-1&paso=5
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
  $('sceneStatus').textContent = 'No se pudo cargar la reproducción v4. Las versiones anteriores siguen disponibles.';
  $('toggle').disabled = true;
}
