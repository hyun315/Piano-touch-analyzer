import React, { useState, useRef, useEffect } from "react";
import { Mic, Square, RotateCcw, ChevronDown, ChevronUp, AlertCircle, Play, Pause } from "lucide-react";

// ---------- 음악 이론 유틸 ----------
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}
function midiToNoteOctave(midiRounded) {
  const name = NOTE_NAMES[((midiRounded % 12) + 12) % 12];
  const octave = Math.floor(midiRounded / 12) - 1;
  return { name, octave };
}

// ACF2+ 자기상관 기반 피치 검출
function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.004) return { freq: -1, rms };

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

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / (arr.length || 1); }
function std(arr, m) { return Math.sqrt(mean(arr.map((v) => (v - m) ** 2))); }

export default function PianoTouchAnalyzer() {
  const [status, setStatus] = useState("idle"); // idle | recording | analyzing | done | error
  const [errorMsg, setErrorMsg] = useState("");
  const [results, setResults] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [jitterTol, setJitterTol] = useState(15); // cents
  const [durTolPct, setDurTolPct] = useState(35); // %
  const [volTolPct, setVolTolPct] = useState(35); // %
  const [elapsed, setElapsed] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [audioUrl, setAudioUrl] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadRatio, setPlayheadRatio] = useState(0);

  const audioCtxRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const samplesRef = useRef([]);
  const startTimeRef = useRef(0);
  const frameCountRef = useRef(0);
  const lastFreqRef = useRef(-1);
  const canvasMeterRef = useRef(null);
  const timerRef = useRef(null);
  const rawResultsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const audioElRef = useRef(null);
  const totalDurationRef = useRef(1);

  const startRecording = async () => {
    setErrorMsg("");
    setResults(null);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    setIsPlaying(false);
    setPlayheadRatio(0);
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

      // 재생용 오디오 녹음
      chunksRef.current = [];
      try {
        const mr = new MediaRecorder(stream);
        mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
        mr.start();
        mediaRecorderRef.current = mr;
      } catch (mrErr) {
        mediaRecorderRef.current = null;
      }

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

        const canvas = canvasMeterRef.current;
        if (canvas) {
          const cctx = canvas.getContext("2d");
          const w = canvas.width, h = canvas.height;
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

    const finishStream = () => {
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.onstop = () => {
        try {
          const blob = new Blob(chunksRef.current, { type: mediaRecorderRef.current.mimeType || "audio/webm" });
          setAudioUrl(URL.createObjectURL(blob));
        } catch (e) { /* 재생용 오디오 생성 실패는 분석에 영향 없음 */ }
        finishStream();
      };
      mediaRecorderRef.current.stop();
    } else {
      finishStream();
    }

    if (audioCtxRef.current) audioCtxRef.current.close();
    setStatus("analyzing");
    setTimeout(() => segment(), 50);
  };

  // 녹음에서 음을 분리해 원시 노트 데이터 생성 (기준 악보 없이)
  const segment = () => {
    const samples = samplesRef.current;
    if (samples.length < 5) {
      setErrorMsg("녹음된 데이터가 너무 짧습니다.");
      setStatus("error");
      return;
    }
    const maxAmp = Math.max(...samples.map((s) => s.amp));
    if (maxAmp < 0.003) {
      setErrorMsg("소리가 감지되지 않았습니다. 마이크 위치와 볼륨을 확인해 주세요.");
      setStatus("error");
      return;
    }
    const onThres = maxAmp * 0.08;
    const offThres = maxAmp * 0.045;
    const minGap = 0.11;

    let onsets = [];
    let sounding = false;
    let lastOnset = -10;
    for (const s of samples) {
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

    const totalEnd = samples[samples.length - 1].t;
    const notes = onsets.map((onsetT, idx) => {
      const nextOnset = idx + 1 < onsets.length ? onsets[idx + 1] : totalEnd;
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
      const validFreqSamples = segSamples.filter((s) => s.freq && s.freq > 0);
      const freqs = validFreqSamples.map((s) => s.freq).sort((a, b) => a - b);
      const medianFreq = freqs.length ? freqs[Math.floor(freqs.length / 2)] : null;
      const peakAmp = Math.max(...samples.filter((s) => s.t >= onsetT && s.t < offT).map((s) => s.amp), 0);
      const duration = Math.max(offT - onsetT, 0.05);

      let noteInfo = null;
      let centsSeries = [];
      if (medianFreq) {
        const midiMedian = freqToMidi(medianFreq);
        const midiRounded = Math.round(midiMedian);
        const { name, octave } = midiToNoteOctave(midiRounded);
        centsSeries = validFreqSamples.map((s) => (freqToMidi(s.freq) - midiRounded) * 100);
        const cents = Math.round((midiMedian - midiRounded) * 100);
        noteInfo = { name, octave, cents };
      }
      const jitter = centsSeries.length > 1 ? std(centsSeries, mean(centsSeries)) : (centsSeries.length === 1 ? 0 : null);
      const confidence = segSamples.length ? validFreqSamples.length / segSamples.length : 0;

      return { onsetT, duration, note: noteInfo, peakAmp, jitter, confidence, sampleCount: validFreqSamples.length };
    });

    rawResultsRef.current = notes;
    analyzeConsistency(notes);
  };

  // 연주 전체 통계 대비 개별 터치의 일관성 분석
  const analyzeConsistency = (notes) => {
    const durs = notes.map((n) => n.duration);
    const amps = notes.map((n) => n.peakAmp);
    const meanDur = mean(durs);
    const meanAmp = mean(amps);

    const evaluated = notes.map((n) => {
      const durDevPct = ((n.duration - meanDur) / meanDur) * 100;
      const volDevPct = ((n.peakAmp - meanAmp) / meanAmp) * 100;
      const durFlag = Math.abs(durDevPct) > durTolPct;
      const volFlag = Math.abs(volDevPct) > volTolPct;
      const shortFlag = n.duration < 0.09;
      const lowConfidenceFlag = n.confidence < 0.35;
      const jitterFlag = n.jitter !== null ? n.jitter > jitterTol : true;
      const ok = !(durFlag || volFlag || shortFlag || lowConfidenceFlag || jitterFlag);
      return { ...n, durDevPct, volDevPct, durFlag, volFlag, shortFlag, lowConfidenceFlag, jitterFlag, ok };
    });

    const totalDuration = Math.max(...evaluated.map((n) => n.onsetT + n.duration), 0.5);
    totalDurationRef.current = totalDuration;
    setResults({ notes: evaluated, meanDur, meanAmp, maxAmp: Math.max(...amps, 0.001), totalDuration });
    setStatus("done");
  };

  // 허용 오차를 바꾸면 이미 녹음된 데이터로 즉시 재평가
  useEffect(() => {
    if (rawResultsRef.current && status === "done") {
      analyzeConsistency(rawResultsRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jitterTol, durTolPct, volTolPct]);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      clearInterval(timerRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePlay = () => {
    const el = audioElRef.current;
    if (!el) return;
    if (el.paused) { el.play(); } else { el.pause(); }
  };

  const handleTimeUpdate = () => {
    const el = audioElRef.current;
    if (!el) return;
    const dur = el.duration && isFinite(el.duration) ? el.duration : totalDurationRef.current;
    setPlayheadRatio(dur > 0 ? el.currentTime / dur : 0);
  };

  const seekTo = (ratio) => {
    const el = audioElRef.current;
    const clamped = Math.max(0, Math.min(1, ratio));
    setPlayheadRatio(clamped);
    if (!el) return;
    const dur = el.duration && isFinite(el.duration) ? el.duration : totalDurationRef.current;
    el.currentTime = clamped * dur;
  };

  const okCount = results ? results.notes.filter((n) => n.ok).length : 0;
  const totalCount = results ? results.notes.length : 0;

  return (
    <div style={{ minHeight: "100vh", background: "#1A140F", color: "#EDE3CB", fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        .keystripe { display:flex; gap:2px; height:6px; margin: 0 0 18px 0; }
        .keystripe span { flex:1; background:#3A2B1C; }
        .keystripe span:nth-child(odd) { background:#4A3A26; }
        button { font-family:'Inter', sans-serif; cursor:pointer; }
        button:focus-visible { outline:2px solid #C9A24D; outline-offset:2px; }
        input[type=range] { accent-color:#C9A24D; }
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
            연주를 녹음하면 음 하나하나의 음정 흔들림·박자·음량을 그 연주 전체의 평균과 비교해, 불완전한 터치를 찾아냅니다.
          </p>
        </div>

        <Section title="연주 녹음" subtitle="마이크에 가까이서 연주한 뒤 정지하세요">
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
          {audioUrl && (
            <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 12, background: "#211712", borderRadius: 10, padding: "10px 14px" }}>
              <button onClick={togglePlay} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, borderRadius: "50%", background: "#4C86B5", color: "#11181F", border: "none", flexShrink: 0 }}>
                {isPlaying ? <Pause size={15} /> : <Play size={15} style={{ marginLeft: 1 }} />}
              </button>
              <audio
                ref={audioElRef}
                src={audioUrl}
                style={{ display: "none" }}
                onTimeUpdate={handleTimeUpdate}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
                onLoadedMetadata={(e) => { if (isFinite(e.currentTarget.duration)) totalDurationRef.current = e.currentTarget.duration; }}
              />
              <div
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  seekTo((e.clientX - rect.left) / rect.width);
                }}
                style={{ flex: 1, height: 6, borderRadius: 3, background: "#3A2B1C", position: "relative", cursor: "pointer" }}
              >
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${playheadRatio * 100}%`, background: "#C9A24D", borderRadius: 3 }} />
                <div style={{ position: "absolute", left: `${playheadRatio * 100}%`, top: -4, width: 14, height: 14, marginLeft: -7, borderRadius: "50%", background: "#EDE3CB", border: "2px solid #C9A24D" }} />
              </div>
            </div>
          )}
          {errorMsg && (
            <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "flex-start", color: "#E0A398", fontSize: 13 }}>
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} /> {errorMsg}
            </div>
          )}
        </Section>

        {status === "done" && results && (
          <Section title="분석 결과" subtitle={`정상 터치 ${okCount} / ${totalCount}`}>
            <PianoRoll notes={results.notes} maxAmp={results.maxAmp} totalDuration={results.totalDuration} playheadRatio={audioUrl ? playheadRatio : null} onSeek={audioUrl ? seekTo : null} />
            <div style={{ display: "grid", gap: 18, marginTop: 22 }}>
              <MiniChart title="음정 흔들림 (cents, 클수록 불안정)" notes={results.notes} valueFn={(n) => n.jitter} okFn={(n) => !n.jitterFlag && !n.lowConfidenceFlag} range={[0, 40]} unit="¢" totalDuration={results.totalDuration} playheadRatio={audioUrl ? playheadRatio : null} onSeek={audioUrl ? seekTo : null} />
              <MiniChart title="박자 편차 (평균 대비 %)" notes={results.notes} valueFn={(n) => n.durDevPct} okFn={(n) => !n.durFlag} range={[-100, 100]} unit="%" baseline={0} totalDuration={results.totalDuration} playheadRatio={audioUrl ? playheadRatio : null} onSeek={audioUrl ? seekTo : null} />
              <MiniChart title="음량 편차 (평균 대비 %)" notes={results.notes} valueFn={(n) => n.volDevPct} okFn={(n) => !n.volFlag} range={[-100, 100]} unit="%" baseline={0} totalDuration={results.totalDuration} playheadRatio={audioUrl ? playheadRatio : null} onSeek={audioUrl ? seekTo : null} />
            </div>

            <div style={{ marginTop: 24, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, fontFamily: "'JetBrains Mono', monospace" }}>
                <thead>
                  <tr style={{ color: "#6E5E45", textAlign: "left" }}>
                    <th style={{ padding: "6px 8px" }}>#</th>
                    <th style={{ padding: "6px 8px" }}>인식음</th>
                    <th style={{ padding: "6px 8px" }}>길이</th>
                    <th style={{ padding: "6px 8px" }}>음량</th>
                    <th style={{ padding: "6px 8px" }}>음정흔들림</th>
                    <th style={{ padding: "6px 8px" }}>비고</th>
                    <th style={{ padding: "6px 8px" }}>판정</th>
                  </tr>
                </thead>
                <tbody>
                  {results.notes.map((n, i) => (
                    <tr key={i} style={{ borderTop: "1px solid #2E2117" }}>
                      <td style={{ padding: "6px 8px", color: "#6E5E45" }}>{i + 1}</td>
                      <td style={{ padding: "6px 8px" }}>{n.note ? `${n.note.name}${n.note.octave}` : "불명확"}</td>
                      <td style={{ padding: "6px 8px", color: n.durFlag ? "#C1473A" : "#4C86B5" }}>{n.duration.toFixed(2)}s</td>
                      <td style={{ padding: "6px 8px", color: n.volFlag ? "#C1473A" : "#4C86B5" }}>{(n.peakAmp / results.maxAmp * 100).toFixed(0)}%</td>
                      <td style={{ padding: "6px 8px", color: (n.jitterFlag || n.lowConfidenceFlag) ? "#C1473A" : "#4C86B5" }}>{n.jitter !== null ? `${n.jitter.toFixed(1)}¢` : "—"}</td>
                      <td style={{ padding: "6px 8px", color: "#8C6450", fontSize: 11 }}>
                        {n.shortFlag ? "너무 짧음" : n.lowConfidenceFlag ? "신호 불안정" : ""}
                      </td>
                      <td style={{ padding: "6px 8px" }}>
                        <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: n.ok ? "#4C86B5" : "#C1473A" }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        <button onClick={() => setShowSettings((s) => !s)} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "#A89678", fontSize: 13, padding: "4px 0", marginBottom: 12 }}>
          {showSettings ? <ChevronUp size={15} /> : <ChevronDown size={15} />} 허용 오차 설정
        </button>
        {showSettings && (
          <div style={{ background: "#211712", borderRadius: 10, padding: 14, marginBottom: 24, display: "flex", flexDirection: "column", gap: 12, fontSize: 13 }}>
            <ToleranceRow label="음정 흔들림 허용" value={jitterTol} unit="cents" min={5} max={50} step={5} onChange={setJitterTol} />
            <ToleranceRow label="박자(길이) 편차 허용" value={durTolPct} unit="%" min={10} max={80} step={5} onChange={setDurTolPct} />
            <ToleranceRow label="음량 편차 허용" value={volTolPct} unit="%" min={10} max={80} step={5} onChange={setVolTolPct} />
            <p style={{ color: "#6E5E45", fontSize: 11.5, margin: 0, lineHeight: 1.5 }}>
              연주 전체의 평균 길이·음량 대비 허용 범위를 벗어나거나, 음정이 흔들리거나(겹침/노이즈), 너무 짧게 끊긴 터치는 자동으로 오차로 표시됩니다.
            </p>
          </div>
        )}

        <button onClick={() => { setResults(null); setStatus("idle"); setErrorMsg(""); rawResultsRef.current = null; if (audioUrl) URL.revokeObjectURL(audioUrl); setAudioUrl(null); setIsPlaying(false); setPlayheadRatio(0); }} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "#6E5E45", fontSize: 12, marginTop: 30 }}>
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

// 피아노 롤 스타일 메인 타임라인 (시그니처 비주얼) — 실제 시간축에 비례 배치
function PianoRoll({ notes, maxAmp, totalDuration, playheadRatio, onSeek }) {
  const dur = totalDuration || Math.max(...notes.map((n) => n.onsetT + n.duration), 0.5);
  const trackH = 90;
  return (
    <div style={{ background: "#13100C", borderRadius: 10, padding: "20px 16px" }}>
      <div
        onClick={onSeek ? (e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onSeek((e.clientX - rect.left) / rect.width);
        } : undefined}
        style={{ position: "relative", height: trackH, cursor: onSeek ? "pointer" : "default" }}
      >
        {notes.map((n, i) => {
          const left = (n.onsetT / dur) * 100;
          const width = (n.duration / dur) * 100;
          const h = 18 + (n.peakAmp / maxAmp) * 60;
          return (
            <div key={i} style={{ position: "absolute", left: `${left}%`, width: `${width}%`, minWidth: 10, bottom: 16, height: h, background: n.ok ? "#4C86B5" : "#C1473A", borderRadius: 4, opacity: 0.92 }}
              title={`${n.note ? n.note.name + n.note.octave : "?"} · ${n.duration.toFixed(2)}s`} />
          );
        })}
        {notes.map((n, i) => {
          const left = (n.onsetT / dur) * 100;
          return (
            <span key={`l${i}`} style={{ position: "absolute", left: `${left}%`, bottom: 0, fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#6E5E45", whiteSpace: "nowrap" }}>
              {n.note ? `${n.note.name}${n.note.octave}` : "?"}
            </span>
          );
        })}
        {playheadRatio !== null && playheadRatio !== undefined && (
          <div style={{ position: "absolute", left: `${playheadRatio * 100}%`, top: 0, bottom: 0, width: 2, background: "#C9A24D", boxShadow: "0 0 6px rgba(201,162,77,0.7)" }} />
        )}
      </div>
      <div style={{ marginTop: 14, display: "flex", gap: 16, fontSize: 11, color: "#A89678" }}>
        <span><span style={{ display: "inline-block", width: 8, height: 8, background: "#4C86B5", borderRadius: 2, marginRight: 5 }} />오차 범위 내</span>
        <span><span style={{ display: "inline-block", width: 8, height: 8, background: "#C1473A", borderRadius: 2, marginRight: 5 }} />오차 범위 초과</span>
        {onSeek && <span style={{ marginLeft: "auto", color: "#6E5E45" }}>그래프를 탭하면 그 위치로 재생됩니다</span>}
      </div>
    </div>
  );
}

// 항목별 미니 그래프 — 실제 시간축에 맞춰 배치, 재생 위치 표시
function MiniChart({ title, notes, valueFn, okFn, range, unit, baseline = 0, totalDuration, playheadRatio, onSeek }) {
  const [lo, hi] = range;
  const h = 70;
  const dur = totalDuration || Math.max(...notes.map((n) => n.onsetT + n.duration), 0.5);
  return (
    <div>
      <div style={{ fontSize: 12.5, color: "#A89678", marginBottom: 6 }}>{title}</div>
      <div style={{ background: "#13100C", borderRadius: 8, padding: "10px 12px", position: "relative" }}>
        <div style={{ position: "absolute", left: 12, right: 12, top: 10 + (1 - (baseline - lo) / (hi - lo)) * h, borderTop: "1px dashed #3A2B1C" }} />
        <div
          onClick={onSeek ? (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onSeek((e.clientX - rect.left) / rect.width);
          } : undefined}
          style={{ height: h, position: "relative", cursor: onSeek ? "pointer" : "default" }}
        >
          {notes.map((n, i) => {
            const v = valueFn(n);
            const ok = okFn(n);
            const left = (n.onsetT / dur) * 100;
            if (v === null || v === undefined || Number.isNaN(v)) {
              return <div key={i} style={{ position: "absolute", left: `${left}%`, bottom: 0, width: 10, height: h, background: "repeating-linear-gradient(45deg,#2E2117,#2E2117 3px,#211712 3px,#211712 6px)", borderRadius: 2 }} title="감지 불가" />;
            }
            const clamped = Math.max(lo, Math.min(hi, v));
            const ratio = (clamped - lo) / (hi - lo);
            const barH = Math.max(3, ratio * h);
            return (
              <div key={i} style={{ position: "absolute", left: `${left}%`, bottom: 0, width: 10, height: barH, background: ok ? "#4C86B5" : "#C1473A", borderRadius: 2 }} title={`${n.note ? n.note.name + n.note.octave : "?"}: ${v.toFixed(1)}${unit}`} />
            );
          })}
          {playheadRatio !== null && playheadRatio !== undefined && (
            <div style={{ position: "absolute", left: `${playheadRatio * 100}%`, top: 0, bottom: 0, width: 2, background: "#C9A24D", boxShadow: "0 0 6px rgba(201,162,77,0.7)" }} />
          )}
        </div>
      </div>
    </div>
  );
}
