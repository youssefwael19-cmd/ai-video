import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppState,
  Aspect,
  JobView,
  KeySlotView,
  KeyTestResult,
  SegmentView,
  SettingsView,
  StylePreset,
} from './types';

const STYLES: { id: StylePreset; label: string; hint: string }[] = [
  { id: 'cinematic', label: 'Cinematic', hint: 'moody light, crisp focus' },
  { id: 'studio', label: 'Studio', hint: 'seamless white softbox' },
  { id: 'bold', label: 'Bold', hint: 'vivid retail colour' },
  { id: 'lifestyle', label: 'Lifestyle', hint: 'warm natural light' },
];

const RATIOS: { id: Aspect; label: string }[] = [
  { id: '9:16', label: '9:16' },
  { id: '1:1', label: '1:1' },
  { id: '16:9', label: '16:9' },
];

type View = 'studio' | 'settings';

export default function App() {
  const [view, setView] = useState<View>('studio');
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

  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [locked, setLocked] = useState(false);
  const [password, setPassword] = useState('');
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
      if (res.status === 404) {
        // The job is gone (pruned, or the volume was reset) — stop claiming it
        // is still rendering.
        setBusy(false);
        setError('That render is no longer on the server — start a new one.');
        return;
      }
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

  const loadSettings = useCallback(async (pass: string) => {
    setSettingsError(null);
    try {
      const res = await fetch('/api/settings', {
        headers: pass ? { 'x-settings-password': pass } : {},
      });
      if (res.status === 401) {
        setLocked(true);
        setSettings(null);
        return;
      }
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not load the keys');
      setSettings(body as SettingsView);
      setLocked(false);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Fetch the key list the first time the Settings tab is opened.
  useEffect(() => {
    if (view === 'settings' && !settings && !locked) void loadSettings(password);
  }, [view, settings, locked, loadSettings, password]);

  const saveSetting = useCallback(
    async (field: string, value: string): Promise<boolean> => {
      setSettingsError(null);
      setNotice(null);
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(password ? { 'x-settings-password': password } : {}),
          },
          body: JSON.stringify({ field, value }),
        });
        const body = await res.json();
        if (res.status === 401) {
          setLocked(true);
          setPassword('');
          return false;
        }
        if (!res.ok) throw new Error(body.error ?? 'Could not save the key');
        setSettings((prev) => (prev ? { ...prev, slots: body.slots as KeySlotView[] } : prev));
        setNotice(value.trim() ? 'Key saved — the provider pool uses it on the next render.' : 'Key removed.');
        void loadState();
        return true;
      } catch (err) {
        setSettingsError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [loadState, password],
  );

  const testSetting = useCallback(
    async (field: string, value: string): Promise<KeyTestResult | null> => {
      setSettingsError(null);
      try {
        const res = await fetch('/api/settings/test', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(password ? { 'x-settings-password': password } : {}),
          },
          body: JSON.stringify({ field, value }),
        });
        const body = await res.json();
        if (res.status === 401) {
          setLocked(true);
          setPassword('');
          return null;
        }
        if (!res.ok) throw new Error(body.error ?? 'Could not test the key');
        return body as KeyTestResult;
      } catch (err) {
        setSettingsError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [password],
  );

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
        <nav className="tabs">
          <button className={`tab ${view === 'studio' ? 'active' : ''}`} onClick={() => setView('studio')}>
            Studio
          </button>
          <button className={`tab ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}>
            Settings
          </button>
        </nav>
        <p className="tagline">One product photo → a 15 second video, generated across free AI providers.</p>
        <div className="topbar-meta">
          <span className={`dot ${state && state.configured > 0 ? 'live' : 'idle'}`} />
          {state ? `${state.configured} of ${state.providers.length} providers ready` : 'checking providers…'}
        </div>
      </header>

      {view === 'settings' ? (
        <KeysPanel
          settings={settings}
          locked={locked}
          password={password}
          setPassword={setPassword}
          error={settingsError}
          notice={notice}
          onUnlock={() => void loadSettings(password)}
          onSave={saveSetting}
          onTest={testSetting}
        />
      ) : (
        <>
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

              <div className={`player aspect-${aspect.replace(':', '-')}`}>
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
                      <span className="mono">
                        {(segment.index + 1) * 5 - 5}s–{(segment.index + 1) * 5}s
                      </span>
                      <span className={`beat-status ${segment.status}`}>{segment.status}</span>
                    </div>
                    <strong>{segment.label}</strong>
                    <span className="beat-provider">
                      {segment.providerLabel
                        ? `${segment.providerLabel}${segment.resolution ? ` · ${segment.resolution}` : ''} · ${segment.attempts} attempt${segment.attempts === 1 ? '' : 's'}`
                        : segment.status === 'fallback'
                          ? 'local motion pass'
                          : segment.status === 'failed'
                            ? 'all providers declined'
                            : 'queued'}
                    </span>
                  </div>
                ))}
              </div>

              {job?.status === 'error' && job.error && <p className="error">{job.error}</p>}

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
                      <dd>
                        {p.successes}/{p.attempts || 0}
                      </dd>
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
                    <p className="provider-note warn">
                      cooling down {p.cooldownSeconds}s after: {p.lastError}
                    </p>
                  )}
                  {!p.configured && (
                    <p className="provider-note">
                      add <code>{p.requires.env}</code> ·{' '}
                      <button className="inline-link" type="button" onClick={() => setView('settings')}>
                        paste a key
                      </button>{' '}
                      ·{' '}
                      <a href={p.requires.signupUrl} target="_blank" rel="noreferrer">
                        sign up
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
                No provider keys yet — uploads still render, using the local motion pass. Paste any key in the{' '}
                <button className="inline-link" type="button" onClick={() => setView('settings')}>
                  Settings tab
                </button>{' '}
                and the pool picks it up on the next request.
              </p>
            )}
            {state?.localFallback && (
              <p className="setup-note">
                Last resort: <strong>local motion pass</strong> — an ffmpeg render of your photo using the same three
                shots and camera moves. It is only used when every AI provider declines, so the app always returns a
                15s file.
              </p>
            )}
          </section>
        </>
      )}

      <footer className="footer">
        <span className="mono">motion/studio</span>
        <span>
          Free-tier providers: Hugging Face Spaces · Novita AI · Magic Hour · Replicate · Agnes AI ·
          Atmee
        </span>
      </footer>
    </div>
  );
}

function KeysPanel(props: {
  settings: SettingsView | null;
  locked: boolean;
  password: string;
  setPassword: (value: string) => void;
  error: string | null;
  notice: string | null;
  onUnlock: () => void;
  onSave: (field: string, value: string) => Promise<boolean>;
  onTest: (field: string, value: string) => Promise<KeyTestResult | null>;
}) {
  const { settings, locked, password, setPassword, error, notice, onUnlock, onSave, onTest } = props;
  const slots = settings?.slots ?? [];
  const setCount = slots.filter((s) => s.configured).length;

  return (
    <section className="panel settings">
      <div className="panel-head">
        <h2>Provider keys</h2>
        <span className="mono">{slots.length ? `${setCount} of ${slots.length} set` : 'loading…'}</span>
      </div>

      <p className="settings-intro">
        Paste a key and save — it is written to the server's data volume and used on the next render. No
        restart, no <code>.env</code> editing, no redeploy. Values are never shown again, only the last four
        characters. Leave a slot empty to skip that provider.
      </p>

      {locked && (
        <form
          className="settings-gate"
          onSubmit={(e) => {
            e.preventDefault();
            onUnlock();
          }}
        >
          <p>This app is protected by a settings password.</p>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Settings password"
            autoComplete="current-password"
          />
          <button className="ghost small" type="submit" disabled={!password}>
            Unlock
          </button>
        </form>
      )}

      {notice && <p className="settings-flash ok">{notice}</p>}
      {error && <p className="error">{error}</p>}

      {!locked && (
        <div className="key-list">
          {slots.map((slot) => (
            <KeyRow key={slot.field} slot={slot} onSave={onSave} onTest={onTest} />
          ))}
        </div>
      )}

      {!locked && (
        <p className="setup-note">
          All six are optional and free. Hugging Face Spaces already works with no key at all; the more slots
          you fill, the less often a beat has to wait for a busy provider.
        </p>
      )}
    </section>
  );
}

function KeyRow({
  slot,
  onSave,
  onTest,
}: {
  slot: KeySlotView;
  onSave: (field: string, value: string) => Promise<boolean>;
  onTest: (field: string, value: string) => Promise<KeyTestResult | null>;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<KeyTestResult | null>(null);

  const submit = async (next: string) => {
    setBusy(true);
    const ok = await onSave(slot.field, next);
    setBusy(false);
    if (ok) {
      setValue('');
      setTestResult(null);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    const result = await onTest(slot.field, value.trim());
    setTesting(false);
    if (result) setTestResult(result);
  };

  return (
    <article className={`key-row ${slot.configured ? 'set' : ''}`}>
      <div className="key-head">
        <div>
          <strong>{slot.label}</strong>
          <span className="mono">
            {slot.env} · {slot.service}
          </span>
        </div>
        <span className={`key-state ${slot.configured ? 'set' : ''}`}>
          {slot.configured ? `${slot.preview} · ${slot.source === 'env' ? 'from env' : 'saved'}` : 'not set'}
        </span>
      </div>

      <form
        className="key-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(value);
        }}
      >
        <input
          type="password"
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          placeholder={slot.configured ? 'Paste a new key to replace…' : 'Paste your key…'}
        />
        <button className="ghost small" type="submit" disabled={busy || !value.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          className="ghost small"
          type="button"
          onClick={() => void test()}
          disabled={testing || busy}
        >
          {testing ? 'Testing…' : 'Test'}
        </button>
        {slot.configured && (
          <button
            className="ghost small danger"
            type="button"
            disabled={busy}
            onClick={() => void submit('')}
          >
            Clear
          </button>
        )}
      </form>

      {testResult && (
        <p className={`key-test ${testTone(testResult)}`}>
          {testResult.message}{' '}
          <span className="mono">{(testResult.ms / 1000).toFixed(1)}s</span>
          {testResult.detail && <span className="key-test-detail"> {testResult.detail}</span>}
        </p>
      )}

      <p className="key-note">
        {slot.note}{' '}
        <a href={slot.signupUrl} target="_blank" rel="noreferrer">
          Get a free key
        </a>
      </p>
    </article>
  );
}

function testTone(result: KeyTestResult): 'ok' | 'warn' | 'bad' {
  if (result.status === 'works' || result.status === 'not-needed') return 'ok';
  if (result.status === 'limited' || result.status === 'no-credits') return 'warn';
  return 'bad';
}

function defaultBeats(): SegmentView[] {
  return [
    { index: 0, label: 'Hero push-in', prompt: '', status: 'pending', attempts: 0 },
    { index: 1, label: 'Surface macro', prompt: '', status: 'pending', attempts: 0 },
    { index: 2, label: 'Slow reveal', prompt: '', status: 'pending', attempts: 0 },
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
