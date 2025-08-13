# Web App: Emociones por Voz (Vercel-Ready, Español)

App web que **graba audio**, calcula **métricas prosódicas** en el navegador (100% cliente) —tasa de habla (proxy), pausas, **jitter**, **shimmer**, **pitch (F0)** y su variabilidad— y estima **seguridad, inseguridad y nerviosismo** con heurísticas.
Opcionalmente, puede **consultar modelos ML** (Hugging Face Inference API) a través de una función serverless (`/api/analyze`) si configuras `HF_TOKEN` en Vercel.

> ⚠️ Uso educativo. No emplear para decisiones sensibles (selección de personal, diagnósticos, etc.).

## Estructura
- `index.html`, `styles.css`, `script.js` → **Frontend estático** (todo cliente).
- `api/health.js` → función serverless simple para comprobar despliegue.
- `api/analyze.js` → (opcional) proxy a Hugging Face Inference API para obtener emociones y dimensiones (requiere `HF_TOKEN`).
- `package.json` → dependencias para parsear `multipart/form-data` en la función serverless.
- `vercel.json` → runtime Node.js 18.

## Despliegue en Vercel
1. Crea un proyecto nuevo en Vercel y **sube esta carpeta**.
2. (Opcional) En **Settings → Environment Variables**, añade:
   - `HF_TOKEN` = tu token de Hugging Face (https://huggingface.co/settings/tokens)
3. Deploy. La web quedará disponible. La función `/api/analyze`:
   - Responderá **501** si no hay `HF_TOKEN` (solo verás métricas locales).
   - Si hay token, combinará resultados ML con las métricas locales (el frontend ya maneja ambos casos).

## Uso
- Abre la app, permite micrófono, presiona **Grabar** y luego **Detener**.
- Verás métricas prosódicas y estados derivados.
- Si `/api/analyze` está activo, se añadirá una sección con emociones del modelo.

## Métricas
- **F0 media (Hz)** y **variabilidad de F0**: estimadas por autocorrelación por frame.
- **RMS (intensidad) media** y **variabilidad RMS**.
- **Jitter** (aprox.): variación ciclo-a-ciclo de F0 entre frames con voz, normalizada.
- **Shimmer** (aprox.): variación de amplitud (RMS) entre frames con voz, normalizada.
- **Pausa (%)**: proporción de frames no sonoros.
- **Tasa de habla (proxy)**: onsets de voz por segundo (aprox. unidades silábicas).

## Derivación de estados (heurísticos)
- **Arousal**: ↑ con F0 media alta, RMS alta, variabilidad de F0 moderada/alta.
- **Dominancia**: ↑ cuando hay pocas pausas, bajo jitter/shimmer, intensidad estable.
- **Valencia (muy aproximada)**: combinación de intensidad estable y F0 media moderada.
- **Seguridad**: dominancia alta + valencia positiva + arousal moderado.
- **Inseguridad**: dominancia baja + pausas altas + jitter/shimmer altos.
- **Nerviosismo**: arousal alto + jitter/shimmer altos + dominancia baja.

## Nota técnica
Los cálculos se realizan con frames de ~20 ms y salto de 10 ms, con resample a 16 kHz en el cliente. El F0 se estima por autocorrelación (rango 40–320 Hz) y se consideran “frames con voz” cuando RMS supera un umbral adaptativo.

## Licencia
MIT.
