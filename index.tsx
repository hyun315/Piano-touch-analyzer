import React, { useState, useRef, useCallback, useEffect } from "react";
import { Mic, Square, Play, Plus, Trash2, RotateCcw, ChevronDown, ChevronUp, AlertCircle } from "lucide-react";

// ---------- 음악 이론 유틸 ----------
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const DYNAMICS = ["pp", "p", "mp", "mf", "f", "ff"];
const DYNAMIC_LABEL = { pp: "여리게(pp)", p: "여리게(p)", mp: "조금여리게(mp)", mf: "조금세게(mf)", f: "세게(f)", ff: "매우세게(ff)" };

function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}
function midiToNoteOctave(midiRounded) {
  const name = NOTE_NAMES[((midiRounded % 12) + 12) % 12];
  const octave = Math.floor(midiRounded / 12) - 1;
  return { name, octave };
}
function noteOctaveToMidi(name, octave) {
  return NOTE_NAMES.indexOf(name) + (octave + 1) * 12;
}

// ACF2+ 자기상관 기반 피치 검출 (Chris Wilson 알고리즘 변형)
function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.008) return { freq: -1, rms };

  let r1 = 0, r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  for (let i = 1; i < SIZE / 2; i++) if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  const trimmed = buf.slice(r1, r2);
  const N = trimmed.length;
  if (N < 8) return { freq: -1, rms };

  const c = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (let j = 0; j < N - i; j++) sum += trimmed[j] * trimmed[j + i];
    c[i] = sum;
  }
  let d = 0;
  while (d < N - 1 && c[d] > c[d + 1]) d++;
  let maxval = -1, maxpos = -1;
  for (let i = d; i < N; i++) {
    if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  }
  let T0 = maxpos;
  if (T0 <= 0) return { freq: -1, rms };
  const x1 = c[T0 - 1] ?? c[T0];
  const x2 = c[T0];
  const x3 = c[T0 + 1] ?? c[T0];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) T0 = T0 - b / (2 * a);
  const freq = sampleRate / T0;
  if (freq < 25 || freq > 4500) return { freq: -1, rms };
  return { freq, rms };
}

// ---------- 기본 레퍼런스 (테스트용 짧은 구절) ----------
const DEFAULT_REFERENCE = [
  { id: 1, name: "C", octave: 4, duration: 0.5, dynamic: "mf" },
  { id: 2, name: "D", octave: 4, duration: 0.5, dynamic: "mf" },
  { id: 3, name: "E", octave: 4, duration: 0.5, dynamic: "f" },
  { id: 4, name: "F", octave: 4, duration: 0.5, dynamic: "f" },
  { id: 5, name: "G", octave: 4, duration: 1.0, dynamic: "ff" },
];

export default function PianoTouchAnalyzer() {
  const [reference, setReference] = useState(DEFAULT_REFERENCE);
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | recording | analyzing | done | error
  const [errorMsg, setErrorMsg] = useState("");
  const [results, setResults] = useState(null); // {detected, paired, extraCount, missingCount}
  const [showSettings, setShowSettings] = useState(false);
  const [pitchTolCents, setPitchTolCents] = useState(50);
  const [durTolPct, setDurTolPct] = useState(30);
  const [dynTolLevels, setDynTolLevels] = useState(1);
  const [elapsed, setElapsed] = useState(0);

  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const samplesRef = useRef([]);
  const startTimeRef = useRef(0);
  const frameCountRef = useRef(0);
  const lastFreqRef = useRef(-1);
  const canvasMeterRef = useRef(null);
  const timerRef = useRef(null);

  // ---------- 레퍼런스 편집 ----------
  const addNote = () => {
    setReference((r) => [
      ...r,
      { id: Date.now(), name: "C", octave: 4, duration: 0.5, dynamic: "mf" },
    ]);
  };
  const removeNote = (id) => setReference((r) => r.filter((n) => n.id !== id));
  const updateNote = (id, field, value) =>
    setReference((r) => r.map((n) => (n.id === id ? { ...n, [field]: value } : n)));

  // ---------- 녹음 ----------
  const startRecording = async () => {
    setErrorMsg("");
    setResults(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      streamRef.current = stream;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;

      samplesRef.current = [];
      frameCountRef.current = 0;
      lastFreqRef.current = -1;
      startTimeRef.current = ctx.currentTime;
      setIsRecording(true);
      setStatus("recording");
      setElapsed(0);

      timerRef.current = setInterval(() => {
        setElapsed(Number((ctx.currentTime - startTimeRef.current).toFixed(1)));
      }, 100);

      const buf = new Float32Array(analyser.fftSize);
      const draw = () => {
        analyser.getFloatTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
        const rms = Math.sqrt(sumSq / buf.length);

        frameCountRef.current++;
        let freq = lastFreqRef.current;
        if (frameCountRef.current % 3 === 0 || rms > 0.02) {
          const r = autoCorrelate(buf, ctx.sampleRate);
          freq = r.freq;
          lastFreqRef.current = freq;
        }
        const t = ctx.currentTime - startTimeRef.current;
        samplesRef.current.push({ t, amp: rms, freq });

        // 라이브 레벨 미터
        const canvas = canvasMeterRef.current;
        if (canvas) {
          const cctx = canvas.getContext("2d");
          const w = canvas.width, h = canvas.height;
          cctx.clearRect(0, 0, w, h);
          cctx.fillStyle = "#2E2117";
          cctx.fillRect(0, 0, w, h);
          const level = Math.min(1, rms * 6);
          const barW = level * w;
          const grad = cctx.createLinearGradient(0, 0, w, 0);
          grad.addColorStop(0, "#4C86B5");
          grad.addColorStop(0.7, "#C9A24D");
          grad.addColorStop(1, "#C1473A");
          cctx.fillStyle = grad;
          cctx.fillRect(0, 0, barW, h);
        }
        rafRef.current = requestAnimationFrame(draw);
      };
      rafRef.current = requestAnimationFrame(draw);
    } catch (e) {
      setErrorMsg("마이크에 접근할 수 없습니다. 브라우저 권한을 확인해 주세요.");
      setStatus("error");
    }
  };

  const stopRecording = () => {
    setIsRecording(false);
    cancelAnimationFrame(rafRef.current);
    clearInterval(timerRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (audioCtxRef.current) audioCtxRef.current.close();
    setStatus("analyzing");
    setTimeout(() => analyze(), 50);
  };

  // ---------- 분석 ----------
  const analyze = () => {
    const samples = samplesRef.current;
    if (samples.length < 5) {
      setErrorMsg("녹음된 데이터가 너무 짧습니다.");
      setStatus("error");
      return;
    }
    const maxAmp = Math.max(...samples.map((s) => s.amp));
    if (maxAmp < 0.01) {
      setErrorMsg("소리가 감지되지 않았습니다. 마이크 위치와 볼륨을 확인해 주세요.");
      setStatus("error");
      return;
    }
    const onThres = maxAmp * 0.12;
    const offThres = maxAmp * 0.07;
    const minGap = 0.13; // 노트간 최소 간격(초)

    // 온셋 검출
    let onsets = [];
    let sounding = false;
    let lastOnset = -10;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (!sounding && s.amp > onThres && s.t - lastOnset > minGap) {
        onsets.push(s.t);
        lastOnset = s.t;
        sounding = true;
      } else if (sounding && s.amp < offThres) {
        sounding = false;
      }
    }
    if (onsets.length === 0) {
      setErrorMsg("음을 감지하지 못했습니다. 좀 더 또렷하게 연주해 주세요.");
      setStatus("error");
      return;
    }

    // 세그먼트 구성 (각 온셋 -> 다음 온셋 또는 무음 시작점)
    const totalEnd = samples[samples.length - 1].t;
    const detected = onsets.map((onsetT, idx) => {
      const nextOnset = idx + 1 < onsets.length ? onsets[idx + 1] : totalEnd;
      // 노트 오프: onset 이후 amp가 offThres 아래로 0.08초 이상 지속되는 시점
      let offT = nextOnset;
      let belowSince = null;
      for (const s of samples) {
        if (s.t <= onsetT) continue;
        if (s.t >= nextOnset) break;
        if (s.amp < offThres) {
          if (belowSince === null) belowSince = s.t;
          if (s.t - belowSince > 0.08) { offT = belowSince; break; }
        } else {
          belowSince = null;
        }
      }
      const segSamples = samples.filter((s) => s.t >= onsetT + 0.03 && s.t < offT);
      const freqs = segSamples.map((s) => s.freq).filter((f) => f && f > 0).sort((a, b) => a - b);
      const medianFreq = freqs.length ? freqs[Math.floor(freqs.length / 2)] : null;
      const peakAmp = Math.max(...samples.filter((s) => s.t >= onsetT && s.t < offT).map((s) => s.amp), 0);
      const duration = Math.max(offT - onsetT, 0.05);

      let noteInfo = null;
      if (medianFreq) {
        const midiF = freqToMidi(medianFreq);
        const midiRounded = Math.round(midiF);
        const cents = Math.round((midiF - midiRounded) * 100);
        const { name, octave } = midiToNoteOctave(midiRounded);
        noteInfo = { name, octave, cents, freq: medianFreq };
      }
      const ratio = peakAmp / maxAmp;
      let dynamic = "pp";
      if (ratio > 0.85) dynamic = "ff";
      else if (ratio > 0.7) dynamic = "f";
      else if (ratio > 0.55) dynamic = "mf";
      else if (ratio > 0.4) dynamic = "mp";
      else if (ratio > 0.2) dynamic = "p";

      return { onsetT, duration, note: noteInfo, dynamic, peakAmp };
    });

    // 레퍼런스와 매칭 (인덱스 기준 단순 정렬 매칭)
    const n = Math.min(reference.length, detected.length);
    const paired = [];
    for (let i = 0; i < n; i++) {
      const ref = reference[i];
      const det = detected[i];
      const pitchOk = det.note ? (det.note.name === ref.name && det.note.octave === Number(ref.octave) && Math.abs(det.note.cents) <= pitchTolCents) : false;
      const durRatio = det.duration / Number(ref.duration);
      const durOk = durRatio >= 1 - durTolPct / 100 && durRatio <= 1 + durTolPct / 100;
      const dynDiff = Math.abs(DYNAMICS.indexOf(det.dynamic) - DYNAMICS.indexOf(ref.dynamic));
      const dynOk = dynDiff <= dynTolLevels;
      const ok = pitchOk && durOk && dynOk;
      paired.push({ index: i, ref, det, pitchOk, durOk, dynOk, ok, durRatio, dynDiff });
    }

    setResults({
      detected,
      paired,
      extraCount: Math.max(0, detected.length - reference.length),
      missingCount: Math.max(0, reference.length - detected.length),
    });
    setStatus("done");
  };

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      clearInterval(timerRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const correctCount = results ? results.paired.filter((p) => p.ok).length : 0;
  const totalCount = results ? results.paired.length : 0;

  return (
    <div style={{ minHeight: "100vh", background: "#1A140F", color: "#EDE3CB", fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        .keystripe { display:flex; gap:2px; height:6px; margin: 0 0 18px 0; }
        .keystripe span { flex:1; background:#3A2B1C; }
        .keystripe span:nth-child(odd) { background:#4A3A26; }
        select, input[type=number], input[type=text] {
          background:#241A12; color:#EDE3CB; border:1px solid #3A2B1C; border-radius:6px; padding:6px 8px; font-family:'JetBrains Mono', monospace; font-size:13px;
        }
        select:focus, input:focus { outline:1px solid #C9A24D; }
        button { font-family:'Inter', sans-serif; cursor:pointer; }
        button:focus-visible { outline:2px solid #C9A24D; outline-offset:2px; }
        ::-webkit-scrollbar { height:6px; width:6px; }
        ::-webkit-scrollbar-thumb { background:#3A2B1C; border-radius:4px; }
      `}</style>

      <div style={{ maxWidth: 760, margin: "0 auto", padding: "28px 18px 60px" }}>
        <div className="keystripe">
          {Array.from({ length: 28 }).map((_, i) => <span key={i} />)}
        </div>

        <div style={{ marginBottom: 24 }}>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: 2, color: "#C9A24D", marginBottom: 6 }}>TOUCH ANALYSIS</div>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 32, margin: 0, color: "#F2EAD8" }}>터치 분석기</h1>
          <p style={{ color: "#A89678", fontSize: 14, marginTop: 8, lineHeight: 1.6 }}>
            기준 악보를 입력하고 피아노를 연주해 녹음하면, 음정·박자·셈여림의 오차를 찾아 그래프로 보여줍니다.
          </p>
        </div>

        {/* 1. 기준 악보 */}
        <Section title="1. 기준 악보" subtitle="연주할 음, 길이(초), 셈여림을 입력하세요">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {reference.map((n, i) => (
              <div key={n.id} style={{ display: "flex", gap: 6, alignItems: "center", background: "#211712", padding: 8, borderRadius: 8 }}>
                <span style={{ width: 18, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#6E5E45" }}>{i + 1}</span>
                <select value={n.name} onChange={(e) => updateNote(n.id, "name", e.target.value)}>
                  {NOTE_NAMES.map((nm) => <option key={nm} value={nm}>{nm}</option>)}
                </select>
                <select value={n.octave} onChange={(e) => updateNote(n.id, "octave", Number(e.target.value))} style={{ width: 56 }}>
                  {[2, 3, 4, 5, 6].map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <input type="number" step="0.1" min="0.1" value={n.duration} onChange={(e) => updateNote(n.id, "duration", e.target.value)} style={{ width: 64 }} title="길이(초)" />
                <span style={{ fontSize: 11, color: "#6E5E45" }}>초</span>
                <select value={n.dynamic} onChange={(e) => updateNote(n.id, "dynamic", e.target.value)} style={{ width: 64 }}>
                  {DYNAMICS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <button onClick={() => removeNote(n.id)} style={{ marginLeft: "auto", background: "none", border: "none", color: "#8C6450", padding: 4 }}>
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
          <button onClick={addNote} style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6, background: "none", border: "1px dashed #3A2B1C", color: "#C9A24D", borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>
            <Plus size={15} /> 음 추가
          </button>
        </Section>

        {/* 2. 녹음 */}
        <Section title="2. 연주 녹음" subtitle="마이크에 가까이서 연주한 뒤 정지하세요">
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
            {!isRecording ? (
              <button onClick={startRecording} style={{ display: "flex", alignItems: "center", gap: 8, background: "#4C86B5", color: "#11181F", border: "none", borderRadius: 24, padding: "10px 20px", fontWeight: 600, fontSize: 14 }}>
                <Mic size={16} /> 녹음 시작
              </button>
            ) : (
              <button onClick={stopRecording} style={{ display: "flex", alignItems: "center", gap: 8, background: "#C1473A", color: "#F2EAD8", border: "none", borderRadius: 24, padding: "10px 20px", fontWeight: 600, fontSize: 14 }}>
                <Square size={16} /> 정지 ({elapsed}s)
              </button>
            )}
            {status === "analyzing" && <span style={{ color: "#C9A24D", fontSize: 13 }}>분석 중…</span>}
          </div>
          <canvas ref={canvasMeterRef} width={680} height={10} style={{ width: "100%", height: 10, borderRadius: 5, display: "block" }} />
          {errorMsg && (
            <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "flex-start", color: "#E0A398", fontSize: 13 }}>
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} /> {errorMsg}
            </div>
          )}
        </Section>

        {/* 설정 */}
        <button onClick={() => setShowSettings((s) => !s)} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "#A89678", fontSize: 13, padding: "4px 0", marginBottom: 12 }}>
          {showSettings ? <ChevronUp size={15} /> : <ChevronDown size={15} />} 허용 오차 설정
        </button>
        {showSettings && (
          <div style={{ background: "#211712", borderRadius: 10, padding: 14, marginBottom: 24, display: "flex", flexDirection: "column", gap: 12, fontSize: 13 }}>
            <ToleranceRow label="음정 오차 허용" value={pitchTolCents} unit="cents" min={10} max={100} step={5} onChange={setPitchTolCents} />
            <ToleranceRow label="박자(길이) 오차 허용" value={durTolPct} unit="%" min={5} max={60} step={5} onChange={setDurTolPct} />
            <ToleranceRow label="셈여림 오차 허용" value={dynTolLevels} unit="단계" min={0} max={3} step={1} onChange={setDynTolLevels} />
          </div>
        )}

        {/* 3. 결과 */}
        {status === "done" && results && (
          <Section title="3. 분석 결과" subtitle={`정확한 터치 ${correctCount} / ${totalCount}` + (results.missingCount ? ` · 못 친 음 ${results.missingCount}개` : "") + (results.extraCount ? ` · 추가 터치 ${results.extraCount}개` : "")}>
            <PianoRoll paired={results.paired} />
            <div style={{ display: "grid", gap: 18, marginTop: 22 }}>
              <MiniChart title="음정 오차 (cents)" paired={results.paired} valueFn={(p) => p.det.note ? p.det.note.cents : null} okFn={(p) => p.pitchOk} range={[-60, 60]} unit="¢" />
              <MiniChart title="박자 비율 (실제/기준)" paired={results.paired} valueFn={(p) => p.durRatio} okFn={(p) => p.durOk} range={[0, 2]} unit="×" baseline={1} />
              <MiniChart title="셈여림 단계 차이" paired={results.paired} valueFn={(p) => DYNAMICS.indexOf(p.det.dynamic) - DYNAMICS.indexOf(p.ref.dynamic)} okFn={(p) => p.dynOk} range={[-3, 3]} unit="단계" />
            </div>

            <div style={{ marginTop: 24, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, fontFamily: "'JetBrains Mono', monospace" }}>
                <thead>
                  <tr style={{ color: "#6E5E45", textAlign: "left" }}>
                    <th style={{ padding: "6px 8px" }}>#</th>
                    <th style={{ padding: "6px 8px" }}>기준음</th>
                    <th style={{ padding: "6px 8px" }}>인식음</th>
                    <th style={{ padding: "6px 8px" }}>음정</th>
                    <th style={{ padding: "6px 8px" }}>박자</th>
                    <th style={{ padding: "6px 8px" }}>셈여림</th>
                    <th style={{ padding: "6px 8px" }}>판정</th>
                  </tr>
                </thead>
                <tbody>
                  {results.paired.map((p) => (
                    <tr key={p.index} style={{ borderTop: "1px solid #2E2117" }}>
                      <td style={{ padding: "6px 8px", color: "#6E5E45" }}>{p.index + 1}</td>
                      <td style={{ padding: "6px 8px" }}>{p.ref.name}{p.ref.octave}</td>
                      <td style={{ padding: "6px 8px" }}>{p.det.note ? `${p.det.note.name}${p.det.note.octave}` : "—"}</td>
                      <td style={{ padding: "6px 8px", color: p.pitchOk ? "#4C86B5" : "#C1473A" }}>{p.det.note ? `${p.det.note.cents > 0 ? "+" : ""}${p.det.note.cents}¢` : "불명확"}</td>
                      <td style={{ padding: "6px 8px", color: p.durOk ? "#4C86B5" : "#C1473A" }}>{p.durRatio.toFixed(2)}×</td>
                      <td style={{ padding: "6px 8px", color: p.dynOk ? "#4C86B5" : "#C1473A" }}>{p.det.dynamic}<span style={{ color: "#6E5E45" }}> / {p.ref.dynamic}</span></td>
                      <td style={{ padding: "6px 8px" }}>
                        <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: p.ok ? "#4C86B5" : "#C1473A" }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        <button onClick={() => { setResults(null); setStatus("idle"); setErrorMsg(""); }} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "#6E5E45", fontSize: 12, marginTop: 30 }}>
          <RotateCcw size={13} /> 초기화
        </button>
      </div>
    </div>
  );
}

function Section({ title, subtitle, children }) {
  return (
    <div style={{ marginBottom: 26 }}>
      <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 18, fontWeight: 600, color: "#F2EAD8", margin: "0 0 2px" }}>{title}</h2>
      {subtitle && <p style={{ color: "#6E5E45", fontSize: 12.5, margin: "0 0 12px" }}>{subtitle}</p>}
      {children}
    </div>
  );
}

function ToleranceRow({ label, value, unit, min, max, step, onChange }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ color: "#A89678" }}>{label}</span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#C9A24D" }}>±{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: "100%" }} />
    </div>
  );
}

// 피아노 롤 스타일 메인 타임라인 (시그니처 비주얼)
function PianoRoll({ paired }) {
  const maxDur = Math.max(...paired.map((p) => p.det.duration), 0.5);
  return (
    <div style={{ background: "#13100C", borderRadius: 10, padding: "20px 16px", overflowX: "auto" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8, minHeight: 90 }}>
        {paired.map((p) => {
          const h = 18 + (p.det.peakAmp / Math.max(...paired.map((q) => q.det.peakAmp), 0.001)) * 60;
          const w = Math.max(14, (p.det.duration / maxDur) * 46);
          return (
            <div key={p.index} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <div title={`${p.ref.name}${p.ref.octave} · ${p.det.duration.toFixed(2)}s · ${p.det.dynamic}`}
                style={{ width: w, height: h, background: p.ok ? "#4C86B5" : "#C1473A", borderRadius: 4, opacity: 0.92 }} />
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#6E5E45" }}>{p.ref.name}{p.ref.octave}</span>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 14, display: "flex", gap: 16, fontSize: 11, color: "#A89678" }}>
        <span><span style={{ display: "inline-block", width: 8, height: 8, background: "#4C86B5", borderRadius: 2, marginRight: 5 }} />오차 범위 내</span>
        <span><span style={{ display: "inline-block", width: 8, height: 8, background: "#C1473A", borderRadius: 2, marginRight: 5 }} />오차 범위 초과</span>
      </div>
    </div>
  );
}

// 항목별 미니 그래프 (음정/박자/셈여림)
function MiniChart({ title, paired, valueFn, okFn, range, unit, baseline = 0 }) {
  const [lo, hi] = range;
  const h = 70;
  return (
    <div>
      <div style={{ fontSize: 12.5, color: "#A89678", marginBottom: 6 }}>{title}</div>
      <div style={{ background: "#13100C", borderRadius: 8, padding: "10px 12px", position: "relative" }}>
        <div style={{ position: "absolute", left: 12, right: 12, top: 10 + (1 - (baseline - lo) / (hi - lo)) * h, borderTop: "1px dashed #3A2B1C" }} />
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: h, position: "relative" }}>
          {paired.map((p) => {
            const v = valueFn(p);
            const ok = okFn(p);
            if (v === null || v === undefined || Number.isNaN(v)) {
              return <div key={p.index} style={{ width: 10, height: h, background: "repeating-linear-gradient(45deg,#2E2117,#2E2117 3px,#211712 3px,#211712 6px)", borderRadius: 2 }} title="감지 불가" />;
            }
            const clamped = Math.max(lo, Math.min(hi, v));
            const ratio = (clamped - lo) / (hi - lo);
            const barH = Math.max(3, ratio * h);
            return (
              <div key={p.index} style={{ width: 10, height: barH, background: ok ? "#4C86B5" : "#C1473A", borderRadius: 2 }} title={`${p.ref.name}${p.ref.octave}: ${typeof v === "number" ? v.toFixed(2) : v}${unit}`} />
            );
          })}
        </div>
      </div>
    </div>
  );
}
