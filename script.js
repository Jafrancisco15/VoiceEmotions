
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const playback = document.getElementById('playback');
const results = document.getElementById('results');

const API_ANALYZE = '/api/analyze'; // opcional

let mediaRecorder, chunks = [], stream;

// Helpers UI
function setBar(id, v01){ const el=document.getElementById(id); el && (el.style.width = `${Math.round(Math.max(0, Math.min(1, v01))*100)}%`); }
function setText(id, text){ const el=document.getElementById(id); el && (el.textContent = text); }
function pct(x){ return `${Math.round(x*100)}%`; }

startBtn.addEventListener('click', async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mt = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
    mediaRecorder = new MediaRecorder(stream, { mimeType: mt });
    chunks = [];

    mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstart = () => {
      statusEl.textContent = 'Grabando…';
      startBtn.disabled = true; stopBtn.disabled = false;
    };
    mediaRecorder.start();
  } catch (e) {
    console.error(e);
    alert('No se pudo acceder al micrófono: ' + e.message);
  }
});

stopBtn.addEventListener('click', async () => {
  if (!mediaRecorder) return;
  mediaRecorder.onstop = async () => {
    const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
    const url = URL.createObjectURL(blob);
    playback.src = url; playback.classList.remove('hidden');
    statusEl.textContent = 'Procesando…';

    try {
      const arrbuf = await blob.arrayBuffer();
      const audioCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 48000*10, 48000); // placeholder
      // decodeAudioData necesita un contexto real, usamos uno provisional
      const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
      const decoded = await tmpCtx.decodeAudioData(arrbuf.slice(0));
      const mono = toMono(decoded);
      const resampled = resampleLinear(mono, decoded.sampleRate, 16000);
      const analysis = analyzeProsody(resampled.data, resampled.sampleRate);
      renderLocal(analysis);

      // Intenta ML si está configurado
      const fd = new FormData(); fd.append('file', blob, 'grabacion.webm');
      let mlOK = false;
      try {
        const r = await fetch(API_ANALYZE, { method:'POST', body: fd });
        if (r.status === 501) {
          // sin token: solo locales
        } else if (r.ok) {
          const data = await r.json();
          renderML(data);
          mlOK = true;
        } else {
          console.warn('ML error', await r.text());
        }
      } catch(_){ /* ignore */ }

      statusEl.textContent = mlOK ? 'Listo (local + ML).' : 'Listo (solo local).';
      results.classList.remove('hidden');
    } catch (e) {
      console.error(e);
      statusEl.textContent = 'Error al procesar audio.';
      alert('Error: ' + e.message);
    } finally {
      stream.getTracks().forEach(t => t.stop());
      startBtn.disabled = false; stopBtn.disabled = true;
    }
  };
  mediaRecorder.stop();
});

function toMono(audioBuffer){
  if (audioBuffer.numberOfChannels === 1) return audioBuffer;
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = audioBuffer.getChannelData(1);
  const out = new Float32Array(audioBuffer.length);
  for (let i=0;i<audioBuffer.length;i++){ out[i]=(ch0[i]+ch1[i])/2; }
  return { getChannelData:()=>out, length: out.length, sampleRate: audioBuffer.sampleRate, numberOfChannels:1 };
}

// Simple linear resampler to ~targetRate
function resampleLinear(audio, srcRate, targetRate){
  const data = audio.getChannelData ? audio.getChannelData(0) : audio;
  if (srcRate === targetRate) return { data, sampleRate: srcRate };
  const ratio = targetRate / srcRate;
  const outLen = Math.round(data.length * ratio);
  const out = new Float32Array(outLen);
  for (let i=0;i<outLen;i++){
    const srcIndex = i / ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0+1, data.length-1);
    const t = srcIndex - i0;
    out[i] = data[i0]*(1-t) + data[i1]*t;
  }
  return { data: out, sampleRate: targetRate };
}

function analyzeProsody(samples, sr){
  // Frameado
  const frameMs = 20, hopMs = 10;
  const frameSize = Math.round(sr * frameMs/1000);
  const hop = Math.round(sr * hopMs/1000);
  const frames = [];
  for (let i=0;i+frameSize<=samples.length;i+=hop){
    frames.push(samples.subarray(i, i+frameSize));
  }

  // Umbral RMS adaptativo
  const rmsAll = frames.map(rms);
  const rmsMedian = median(rmsAll);
  const thresh = Math.max(0.02, rmsMedian*0.6);

  const voiced = frames.map((f,i)=> rmsAll[i] > thresh);
  // Pitch por autocorrelación
  const f0s = frames.map((f,i)=> voiced[i] ? estimateF0ACF(f, sr) : null);
  const f0Valid = f0s.filter(x => x && isFinite(x) && x>40 && x<320);
  const f0Mean = mean(f0Valid);
  const f0Std = std(f0Valid);
  const jitter = calcJitter(f0s);

  // Shimmer ~ variación de RMS entre frames con voz
  const rmsVoiced = rmsAll.filter((_,i)=>voiced[i]);
  const shimmer = calcShimmer(rmsVoiced);

  const pauseRatio = 1 - (rmsVoiced.length / frames.length);
  const durationSec = samples.length / sr;

  // Onsets de voz (proxy tasa de habla)
  let onsets = 0, prev=false;
  for (let i=0;i<voiced.length;i++){ if (voiced[i] && !prev) onsets++; prev = voiced[i]; }
  const speechRateProxy = onsets / durationSec; // unidades/s (aprox silábicas)

  const rmsMean = mean(rmsVoiced);
  const rmsStd = std(rmsVoiced);

  // Derivación heurística
  const arousal = clamp01( 0.45*n01(rmsMean, 0.02, 0.2) + 0.35*n01(f0Mean||0, 90, 240) + 0.20*n01(f0Std||0, 5, 40) );
  const dominance = clamp01( 0.45*(1 - pauseRatio) + 0.25*(1 - n01(jitter||0, 0.005, 0.06)) + 0.20*(1 - n01(shimmer||0, 0.02, 0.3)) + 0.10*(1 - n01(rmsStd||0, 0.01, 0.1)) );
  const valence = clamp01( 0.5*(1 - n01(jitter||0, 0.005, 0.06)) + 0.3*(1 - n01(shimmer||0, 0.02, 0.3)) + 0.2*n01(rmsMean, 0.03, 0.15) );

  const seguridad = clamp01( 0.55*dominance + 0.25*valence + 0.20*(1 - Math.abs(arousal - 0.6)) );
  const inseguridad = clamp01( 0.5*(1-dominance) + 0.3*(1-valence) + 0.2*pauseRatio );
  const nerviosismo = clamp01( 0.55*arousal + 0.25*n01(jitter||0, 0.005, 0.06) + 0.20*(1-dominance) );

  return {
    sr,
    durationSec,
    f0Mean: f0Mean || 0,
    f0Std: f0Std || 0,
    jitter: jitter || 0,
    shimmer: shimmer || 0,
    rmsMean: rmsMean || 0,
    rmsStd: rmsStd || 0,
    pauseRatio,
    speechRateProxy,
    arousal, dominance, valence,
    seguridad, inseguridad, nerviosismo
  };
}

// Metrics helpers
function rms(frame){ let s=0; for (let i=0;i<frame.length;i++){ const x=frame[i]; s+=x*x; } return Math.sqrt(s/frame.length); }
function zeroCross(frame){ let z=0; for (let i=1;i<frame.length;i++){ if ((frame[i-1]>=0) !== (frame[i]>=0)) z++; } return z; }
function estimateF0ACF(frame, sr){
  // Autocorrelación normalizada buscando lags 50..400 (40–320 Hz a 16k; ajustamos por sr)
  const minLag = Math.max( Math.floor(sr/320), 2 );
  const maxLag = Math.min( Math.floor(sr/40), frame.length-2 );
  let bestLag = -1, bestR = 0;
  // Normalizar por energía
  let energy = 0; for (let i=0;i<frame.length;i++){ energy += frame[i]*frame[i]; }
  if (energy < 1e-6) return null;
  for (let lag=minLag; lag<=maxLag; lag++){
    let sum=0;
    for (let i=0;i+lag<frame.length;i++){ sum += frame[i]*frame[i+lag]; }
    const r = sum/energy;
    if (r>bestR){ bestR=r; bestLag=lag; }
  }
  if (bestR < 0.3 || bestLag <= 0) return null;
  return sr / bestLag;
}
function calcJitter(f0s){
  const seq = f0s.filter(x=>x && isFinite(x));
  if (seq.length < 3) return 0;
  let diffs = 0, count = 0;
  for (let i=1;i<seq.length;i++){ diffs += Math.abs(seq[i]-seq[i-1]); count++; }
  const meanF0 = mean(seq);
  if (!meanF0) return 0;
  return (diffs / count) / meanF0; // jitter relativo
}
function calcShimmer(rmsSeq){
  if (!rmsSeq || rmsSeq.length<3) return 0;
  let diffs = 0;
  for (let i=1;i<rmsSeq.length;i++){ diffs += Math.abs(rmsSeq[i]-rmsSeq[i-1]); }
  const meanR = mean(rmsSeq);
  if (!meanR) return 0;
  return (diffs/(rmsSeq.length-1)) / meanR;
}
function mean(a){ if (!a || !a.length) return 0; return a.reduce((x,y)=>x+y,0)/a.length; }
function std(a){ if (!a || a.length<2) return 0; const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); }
function median(a){ if (!a || !a.length) return 0; const b=[...a].sort((x,y)=>x-y); const mid=Math.floor(b.length/2); return b.length%2?b[mid]:(b[mid-1]+b[mid])/2; }
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function n01(x, lo, hi){ const xc=Math.max(lo, Math.min(hi, x)); return (xc-lo)/(hi-lo); }

function renderLocal(A){
  const grid = document.getElementById('metrics');
  grid.innerHTML = '';
  const items = [
    ['F0 medio (Hz)', A.f0Mean.toFixed(1)],
    ['F0 σ (Hz)', A.f0Std.toFixed(1)],
    ['Jitter (rel.)', A.jitter.toFixed(3)],
    ['Shimmer (rel.)', A.shimmer.toFixed(3)],
    ['RMS medio', A.rmsMean.toFixed(3)],
    ['RMS σ', A.rmsStd.toFixed(3)],
    ['Pausa (%)', Math.round(A.pauseRatio*100)+'%'],
    ['Tasa habla (proxy, 1/s)', A.speechRateProxy.toFixed(2)],
    ['Arousal', A.arousal.toFixed(2)],
    ['Dominancia', A.dominance.toFixed(2)],
    ['Valencia (aprox.)', A.valence.toFixed(2)],
  ];
  for (const [k,v] of items){
    const div = document.createElement('div'); div.className='metric card';
    div.innerHTML = `<span>${k}</span><div><strong>${v}</strong></div>`;
    grid.appendChild(div);
  }

  setBar('seguridadBar', A.seguridad); setText('seguridadVal', pct(A.seguridad));
  setBar('inseguridadBar', A.inseguridad); setText('inseguridadVal', pct(A.inseguridad));
  setBar('nerviosismoBar', A.nerviosismo); setText('nerviosismoVal', pct(A.nerviosismo));
}

function renderML(data){
  const block = document.getElementById('mlBlock');
  block.classList.remove('hidden');

  const discrete = document.getElementById('discrete');
  discrete.innerHTML = '';
  (data.discrete_emotions || []).forEach(item => {
    const p = document.createElement('div'); p.className='pill';
    p.innerHTML = `<strong>${item.label || item.etiqueta}</strong> <span>${(item.score || item.probabilidad*100).toFixed(2)}</span>`;
    discrete.appendChild(p);
  });

  const dims = data.dimensiones || {};
  const val = dims.valencia ?? 0, aro = dims.activacion_arousal ?? 0, dom = dims.dominancia ?? 0;
  setBar('valenciaBar', (val + 1)/2); setText('valenciaVal', (val).toFixed(2));
  setBar('arousalBar', (aro + 1)/2); setText('arousalVal', (aro).toFixed(2));
  setBar('dominanceBar', (dom + 1)/2); setText('dominanceVal', (dom).toFixed(2));
}

