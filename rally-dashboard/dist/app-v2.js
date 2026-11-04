// Replay of the actual Python experiment. No duplicated environment or Q updates.
const $ = id => document.getElementById(id);
const signed = (n, digits = 2) => `${n >= 0 ? '+' : ''}${Number(n).toFixed(digits)}`;
let data, run, samples = [], selected = 0, frameIndex = 0, timer, playing = true;

function render() {
  const sample = samples[selected], frame = sample.frames[frameIndex];
  const config = run.config ?? data.config;
  const env = config.environment;
  $('episode').textContent = sample.episode;
  $('episodeMax').textContent = sample.mode === 'evaluation' ? config.training.evaluation_episodes : config.training.episodes;
  $('progress').firstChild.textContent = frame.progress_pct.toFixed(0);
  $('progressBar').style.width = `${frame.progress_pct}%`;
  $('distance').textContent = `${frame.position_meters} m de ${env.track_length_meters} m`;
  $('step').firstChild.textContent = `${frame.steps} `;
  $('step').querySelector('small').textContent = `/ ${env.max_steps}`;
  $('action').textContent = frame.action === null ? 'INICIO' : env.actions[frame.action].name.toUpperCase();
  $('reward').textContent = signed(frame.reward);
  $('return').textContent = signed(frame.return);
  $('trackScore').textContent = `PUNTOS ${signed(frame.return)}`;
  $('fuel').textContent = frame.fuel.toFixed(1);
  $('speedLevel').textContent = `${frame.speed_level} / ${env.max_speed_level}`;
  $('zone').textContent = `${frame.zone_name.replaceAll('_', ' ')} · ${frame.grip}`;
  $('offTrack').textContent = `${frame.off_track_count} / ${env.max_off_track_count}`;
  $('status').textContent = frame.termination_cause.replaceAll('_', ' ').toUpperCase();
  $('stateLabel').textContent = `s = (${(frame.decision_observation ?? frame.observation).join(', ')})`;
  for (const [index, name] of ['qBrake','qMaintain','qDrive'].entries()) $(name).textContent = signed(frame.q_values[index], 3);
  $('qValue').textContent = signed(Math.max(...frame.q_values), 3);
  const route = $('racingLine'), length = route.getTotalLength();
  const p = route.getPointAtLength(length * frame.position_meters / env.track_length_meters);
  $('car').setAttribute('transform', `translate(${p.x} ${p.y})`);
  window.rallyVisualState = { position: frame.position_meters, episode: `${run.seed}:${selected}`, step: frame.steps, duration: Number($('speed').value) };
  window.dispatchEvent(new CustomEvent('rally:frame', { detail: window.rallyVisualState }));
  $('loadStatus').textContent = `${sample.mode === 'evaluation' ? 'Evaluación greedy · política congelada' : 'Muestra del entrenamiento registrado'} · semilla ${run.seed} · episodio ${sample.episode}. Datos reales de Python; reproducción, no entrenamiento en vivo.`;
}

function schedule() {
  clearTimeout(timer);
  if (playing) timer = setTimeout(tick, Number($('speed').value));
}
function tick() {
  if (!playing) return;
  if (frameIndex < samples[selected].frames.length - 1) frameIndex++;
  else {
    selected = (selected + 1) % samples.length;
    $('replaySelect').value = String(selected);
    frameIndex = 0;
  }
  render(); schedule();
}
function selectSeed() {
  clearTimeout(timer);
  run = data.runs.find(r => String(r.seed) === $('seedSelect').value);
  samples = [{ mode: 'evaluation', episode: 1, frames: run.evaluation.replay }, ...run.training_replays.map(r => ({ mode: 'training', ...r }))];
  $('replaySelect').replaceChildren(...samples.map((s, i) => new Option(`${s.mode === 'evaluation' ? 'Evaluación' : 'Entrenamiento'} · episodio ${s.episode}`, String(i))));
  selected = frameIndex = 0;
  const metrics = run.evaluation.summary;
  $('seedSummary').textContent = `Semilla ${run.seed}: ${data.config.training.episodes} episodios entrenados. Evaluación: ${(metrics.success_rate * 100).toFixed(1)}% éxito, retorno medio ${metrics.mean_return.toFixed(2)}. Modelo ${run.experiment_id}.`;
  render(); schedule();
}

try {
  const response = await fetch('v2-results.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('No están disponibles las corridas v2. Ejecuta python pipeline_v2.py.');
  data = await response.json();
  window.rallyV2Config = data.config;
  $('seedSelect').replaceChildren(...data.runs.map(r => new Option(String(r.seed), String(r.seed))));
  $('seedSelect').disabled = $('replaySelect').disabled = $('toggle').disabled = false;
  const reward = data.config.reward;
  $('rewardRule').textContent = `Por paso ${reward.step}; tramo nuevo +${reward.new_segment}; combustible ${reward.fuel_unit}/unidad; salida ${reward.off_track}; meta +${reward.finish} y +${reward.remaining_fuel_unit}/unidad restante.`;
  const stats = data.between_seed_evaluation.mean_return;
  $('variance').textContent = `Entre semillas (${data.runs.length}): retorno medio ${stats.mean.toFixed(2)}, varianza muestral ${stats.sample_variance === null ? 'no disponible' : stats.sample_variance.toFixed(4)}. Ambiente determinista.`;
  selectSeed();
  await import('./scene-v2.js');
  $('seedSelect').onchange = selectSeed;
  $('replaySelect').onchange = () => { selected = Number($('replaySelect').value); frameIndex = 0; render(); schedule(); };
  $('toggle').onclick = () => { playing = !playing; $('toggle').textContent = playing ? 'Pausar reproducción' : 'Reanudar reproducción'; schedule(); };
  $('reset').onclick = () => { frameIndex = 0; render(); schedule(); };
  $('speed').oninput = schedule;
} catch (error) {
  clearTimeout(timer);
  $('loadStatus').textContent = error.message;
  $('sceneStatus').textContent = 'No se pudo cargar la reproducción v2. El experimento 1 sigue disponible.';
  $('toggle').disabled = true;
}
