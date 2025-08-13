const Busboy = require('busboy');

const HF_ENDPOINTS = {
  discrete: 'https://api-inference.huggingface.co/models/superb/hubert-large-superb-er',
  dims: 'https://api-inference.huggingface.co/models/audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim',
};

async function readFileFromRequest(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    let fileChunks = [];
    let found = false;
    bb.on('file', (name, file, info) => {
      found = true;
      file.on('data', (data) => fileChunks.push(data));
      file.on('end', () => {});
    });
    bb.on('error', reject);
    bb.on('finish', () => {
      if (!found) return reject(new Error('No file field found'));
      resolve(Buffer.concat(fileChunks));
    });
    req.pipe(bb);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.HF_TOKEN) {
    return res.status(501).json({ error: 'HF_TOKEN not configured' });
  }

  let audioBuf;
  try {
    audioBuf = await readFileFromRequest(req);
  } catch (e) {
    return res.status(400).json({ error: 'Bad upload: ' + e.message });
  }

  async function hfCall(url) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.HF_TOKEN,
        'Content-Type': 'application/octet-stream',
      },
      body: audioBuf
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error('HF error: ' + r.status + ' ' + t);
    }
    return r.json();
  }

  try {
    const [disc, dims] = await Promise.all([hfCall(HF_ENDPOINTS.discrete), hfCall(HF_ENDPOINTS.dims)]);

    // dims example: [{label:"valence", score:0.12}, ...]
    const dmap = Object.fromEntries(dims.map(x => [x.label.toLowerCase(), x.score]));
    const val = +((dmap.valence ?? 0) || 0);
    const aro = +((dmap.arousal ?? 0) || 0);
    const dom = +((dmap.dominance ?? 0) || 0);

    function norm01(x, lo=-1, hi=1){
      const xc = Math.max(lo, Math.min(hi, x));
      return (xc - lo)/(hi-lo);
    }
    function score_seguridad(valence, arousal, dominance){
      const v = norm01(valence);
      const d = norm01(dominance);
      const a = norm01(arousal);
      let score = 0.55*d + 0.35*v + 0.10*(1.0 - Math.abs(a - 0.6));
      return Math.max(0, Math.min(1, score));
    }
    function score_inseguridad(valence, arousal, dominance){
      const v = 1.0 - norm01(valence);
      const d = 1.0 - norm01(dominance);
      const a = norm01(arousal);
      let score = 0.5*d + 0.35*v + 0.15*a;
      return Math.max(0, Math.min(1, score));
    }
    function score_nerviosismo(valence, arousal, dominance){
      const a = norm01(arousal);
      const d = 1.0 - norm01(dominance);
      const v = 1.0 - norm01(valence);
      let score = 0.6*a + 0.3*d + 0.1*v;
      return Math.max(0, Math.min(1, score));
    }

    return res.status(200).json({
      ok: true,
      discrete_emotions: disc,
      dimensiones: { valencia: val, activacion_arousal: aro, dominancia: dom },
      estados_derivados: {
        seguridad: score_seguridad(val, aro, dom),
        inseguridad: score_inseguridad(val, aro, dom),
        nerviosismo: score_nerviosismo(val, aro, dom),
      }
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
