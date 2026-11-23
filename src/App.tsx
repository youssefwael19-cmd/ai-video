import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, Aspect, JobView, SegmentView, StylePreset } from './types';

const STYLES: { id: StylePreset; label: string; hint: string }[] = [
  { id: 'cinematic', label: 'Cinematic', hint: 'moody light, film grain' },
  { id: 'studio', label: 'Studio', hint: 'seamless white softbox' },
  { id: 'bold', label: 'Bold', hint: 'vivid retail colour' },
  { id: 'lifestyle', label: 'Lifestyle', hint: 'warm natural light' },
];

const RATIOS: { id: Aspect; label: string }[] = [
  { id: '9:16', label: '9:16' },
  { id: '1:1', label: '1:1' },
  { id: '16:9', label: '16:9' },
];

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [brief, setBrief] = useState('');
  const [style, setStyle] = useState<StylePreset>('cinematic');
  const [aspect, setAspect] = useState<Aspect>('9:16');
  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadState = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (res.ok) setState((await res.json()) as AppState);
    } catch {
      /* the API is local; a transient failure just retries on the next action */
    }
  }, []);

  useEffect(() => {
    void loadState();
    const id = setInterval(loadState, 15000);
    return () => clearInterval(id);
  }, [loadState]);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const running = job && (job.status === 'queued' || job.status === 'running' || job.status === 'composing');

  useEffect(() => {
    if (!running || !job) return;
    const id = setInterval(async () => {
      const res = await fetch(`/api/jobs/${job.id}`);
      if (!res.ok) return;
      const next = (await res.json()) as JobView;
      setJob(next);
      if (next.status === 'done' || next.status === 'error') {
        setBusy(false);
        void loadState();
      }
    }, 1400);
    return () => clearInterval(id);
  }, [running, job, loadState]);

  const pickFile = (next: File | null | undefined) => {
    if (!next) return;
    if (!next.type.startsWith('image/')) {
      setError('That file is not an image. Use a PNG, JPG or WEBP product photo.');
      return;
    }
    setError(null);
    setFile(next);
  };

  const generate = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    setJob(null);

    const form = new FormData();
    form.append('image', file);
    form.append('brief', brief);
    form.append('style', style);
    form.append('aspect', aspect);

    try {
      const res = await fetch('/api/jobs', { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not start the render');
      setJob(body as JobView);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const resetProviders = async () => {
    await fetch('/api/providers/reset', { method: 'POST' });
    void loadState();
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="wordmark">
          <span className="mark">◧</span>
          <span>
            Motion<span className="slash">/</span>Studio
          </span>
        </div>
        <p className="tagline">One product photo → a 15 second video, generated across free AI providers.</p>
        <div className="topbar-meta">
          <span className={`dot ${state && state.configured > 0 ? 'live' : 'idle'}`} />
          {state ? `${state.configured} of ${state.providers.length} providers ready` : 'checking providers…'}
        </div>
      </header>

      <main className="layout">
        <section className="panel controls">
          <div className="panel-head">
            <h2>Source</h2>
            <span className="mono">01 — 04</span>
          </div>

          <div
            className={`dropzone ${dragging ? 'dragging' : ''} ${preview ? 'filled' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              pickFile(e.dataTransfer.files?.[0]);
            }}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
            }}
          >
            {preview ? (
              <>
                <img src={preview} alt="Product upload preview" />
                <div className="dropzone-caption">
                  <strong>{file?.name}</strong>
                  <span>Click to replace</span>
                </div>
              </>
            ) : (
              <div className="dropzone-empty">
                <span className="drop-icon">＋</span>
                <strong>Drop a product photo</strong>
                <span>PNG, JPG or WEBP · front-facing works best</span>
              </div>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
          </div>

          <label className="field">
            <span className="field-label">
              Product brief <em>optional</em>
            </span>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              maxLength={600}
              rows={3}
              placeholder="Matte forest-green ceramic coffee bag, gold foil label, 250g"
            />
          </label>

          <div className="field">
            <span className="field-label">Look</span>
            <div className="chips">
              {STYLES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`chip ${style === s.id ? 'active' : ''}`}
                  onClick={() => setStyle(s.id)}
                  title={s.hint}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="field-label">Frame</span>
            <div className="chips">
              {RATIOS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`chip ratio ${aspect === r.id ? 'active' : ''}`}
                  onClick={() => setAspect(r.id)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <button className="generate" onClick={generate} disabled={!file || busy}>
            {busy ? (
              <>
                <span className="spinner" /> Rendering 15s…
              </>
            ) : (
              <>Generate 15s video</>
            )}
          </button>

          <p className="fineprint">
            Three 5-second beats are generated, then stitched to exactly 15.0s. If a provider is busy it is
            skipped and the next one in the pool takes the beat.
          </p>

          {error && <p className="error">{error}</p>}
        </section>

        <section className="panel stage">
          <div className="panel-head">
            <h2>Stage</h2>
            <span className="mono">{job ? job.status.toUpperCase() : 'IDLE'}</span>
          </div>

          <div className={`player ${aspect.replace(':', '-')}`}>
            {job?.videoUrl ? (
              <video src={job.videoUrl} controls autoPlay loop playsInline />
            ) : preview ? (
              <img src={preview} alt="Product" className="player-still" />
            ) : (
              <div className="player-empty">
                <span className="mono">15.0s · {aspect}</span>
                <p>Your product video will appear here.</p>
              </div>
            )}
            {running && (
              <div className="player-progress">
                <div className="bar">
                  <div style={{ width: `${job?.progress ?? 0}%` }} />
                </div>
                <span className="mono">
                  {job?.status === 'composing' ? 'compositing' : 'generating'} · {job?.progress ?? 0}%
                </span>
              </div>
            )}
          </div>

          <div className="beats">
            {(job?.segments ?? defaultBeats()).map((segment) => (
              <div key={segment.index} className={`beat ${segment.status}`}>
                <div className="beat-top">
                  <span className="mono">{(segment.index + 1) * 5 - 5}s–{(segment.index + 1) * 5}s</span>
                  <span className={`beat-status ${segment.status}`}>{segment.status}</span>
                </div>
                <strong>{segment.label}</strong>
                <span className="beat-provider">
                  {segment.providerLabel
                    ? `${segment.providerLabel} · ${segment.attempts} attempt${segment.attempts === 1 ? '' : 's'}`
                    : segment.status === 'fallback'
                      ? 'local motion pass'
                      : segment.status === 'failed'
                        ? 'all providers declined'
                        : 'queued'}
                </span>
              </div>
            ))}
          </div>

          {job && (
            <div className="stage-actions">
              {job.videoUrl && (
                <>
                  <a className="download" href={job.downloadUrl ?? job.videoUrl}>
                    Download MP4
                  </a>
                  <button className="ghost" onClick={generate} disabled={!file || busy}>
                    Render again
                  </button>
                </>
              )}
              {job.usedFallback && (
                <span className="badge warn">local fallback — no AI beat succeeded</span>
              )}
              {job.videoUrl && !job.usedFallback && <span className="badge">15.0s · {job.aspect} · h.264</span>}
            </div>
          )}

          {job && <LogConsole log={job.log} />}
        </section>
      </main>

      <section className="panel providers">
        <div className="panel-head">
          <h2>Provider pool</h2>
          <div className="provider-actions">
            <span className="mono">failover order · left to right</span>
            <button className="ghost small" onClick={resetProviders}>
              Reset health
            </button>
          </div>
        </div>

        <div className="provider-grid">
          {(state?.providers ?? []).map((p) => (
            <article key={p.id} className={`provider ${p.status}`}>
              <div className="provider-head">
                <span className={`dot ${p.configured ? p.status : 'idle'}`} />
                <strong>{p.service}</strong>
                <span className="mono">{p.status}</span>
              </div>
              <p className="provider-model">{p.model}</p>
              <dl>
                <div>
                  <dt>clips</dt>
                  <dd>{p.successes}/{p.attempts || 0}</dd>
                </div>
                <div>
                  <dt>avg</dt>
                  <dd>{p.avgMs ? `${(p.avgMs / 1000).toFixed(1)}s` : '—'}</dd>
                </div>
                <div>
                  <dt>max</dt>
                  <dd>{p.maxSeconds}s</dd>
                </div>
              </dl>
              {p.cooldownSeconds > 0 && (
                <p className="provider-note warn">cooling down {p.cooldownSeconds}s after: {p.lastError}</p>
              )}
              {!p.configured && (
                <p className="provider-note">
                  add <code>{p.requires.env}</code> ·{' '}
                  <a href={p.requires.signupUrl} target="_blank" rel="noreferrer">
                    get a free key
                  </a>
                </p>
              )}
              {p.configured && p.status !== 'cooling' && p.lastError && (
                <p className="provider-note subtle">{p.lastError}</p>
              )}
            </article>
          ))}
        </div>

        {state && state.configured === 0 && (
          <p className="setup-note">
            No provider keys yet — uploads still render, using the local motion pass. Add any key from{' '}
            <code>.env</code> (see <code>.env.example</code>) and the pool picks it up on the next request.
          </p>
        )}
        {state?.localFallback && (
          <p className="setup-note">
            Last resort: <strong>local motion pass</strong> — an ffmpeg Ken Burns render of your photo. It is
            only used when every AI provider declines, so the app always returns a 15s file.
          </p>
        )}
      </section>

      <footer className="footer">
        <span className="mono">motion/studio</span>
        <span>Free-tier providers: Hugging Face Spaces · Novita AI · Magic Hour</span>
      </footer>
    </div>
  );
}

function defaultBeats(): SegmentView[] {
  return [
    { index: 0, label: 'Hero push-in', prompt: '', status: 'pending', attempts: 0 },
    { index: 1, label: 'Detail glide', prompt: '', status: 'pending', attempts: 0 },
    { index: 2, label: 'Hero rotation', prompt: '', status: 'pending', attempts: 0 },
  ];
}

function LogConsole({ log }: { log: JobView['log'] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [log]);

  return (
    <div className="console" ref={ref}>
      {log.length === 0 && <p className="console-empty">Waiting for the first beat…</p>}
      {log.map((line, index) => (
        <p key={`${line.at}-${index}`} className={`log ${line.kind}`}>
          <span className="mono">{new Date(line.at).toLocaleTimeString([], { hour12: false })}</span>
          {line.text}
        </p>
      ))}
    </div>
  );
}
