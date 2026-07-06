import { useState, useRef } from "react";

// ---------- Design tokens ----------
const T = {
  bg: "#F4F6F1",
  ink: "#21301F",
  green: "#2F6B4F",
  greenDark: "#1E4A36",
  marigold: "#D9A441",
  muted: "#6B7568",
  card: "#FFFFFF",
  line: "#DDE3D8",
  display: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  body: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
};

// Weeks rule: 1 book -> 4 wk, 2-3 books -> 8 wk, 4+ -> 12 wk
const scheduleFor = (count) => (count >= 4 ? 12 : count >= 2 ? 8 : 4);

// ---------- Claude API helpers ----------
async function callClaude(content) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "API error");
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function parseJson(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = Math.min(
    ...["{", "["].map((c) => (clean.indexOf(c) === -1 ? Infinity : clean.indexOf(c)))
  );
  return JSON.parse(clean.slice(start));
}

// Resize an uploaded photo so the payload stays small, return base64 JPEG
function fileToBase64Jpeg(file, maxEdge = 1400) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
    };
    img.onerror = () => reject(new Error("Could not read image"));
    img.src = url;
  });
}

// ---------- Agent steps ----------
async function extractTitles(base64) {
  const text = await callClaude([
    {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: base64 },
    },
    {
      type: "text",
      text:
        'Read the book spines in this photo. List every title you can identify with reasonable confidence; skip unreadable spines. Respond ONLY with a JSON array, no prose, no markdown: [{"title":"...","author":"..."}] (author may be an empty string).',
    },
  ]);
  const arr = parseJson(text);
  return Array.isArray(arr) ? arr : [];
}

async function categorize(books, projects) {
  const text = await callClaude([
    {
      type: "text",
      text:
        `Project categories: ${JSON.stringify(projects)}\n` +
        `Books: ${JSON.stringify(books.map((b) => b.title))}\n` +
        'Assign each book to the single best-fitting project category, but only if it is genuinely relevant to that project. Books that fit none go in "unmatched". Respond ONLY with JSON, no prose: {"categories":[{"project":"...","books":["title", "..."]}],"unmatched":["title"]}',
    },
  ]);
  return parseJson(text);
}

async function buildCurriculum(project, books, weeks) {
  const text = await callClaude([
    {
      type: "text",
      text:
        `Design a ${weeks}-week self-study curriculum for the project "${project}" built around these books the learner already owns: ${JSON.stringify(
          books
        )}.\n` +
        "Pace the reading across the weeks and pair it with hands-on practice. Keep every field SHORT. " +
        'Respond ONLY with JSON, no prose: {"weeks":[{"week":1,"theme":"max 6 words","reading":"book + chapters/pages for the week","practice":"one concrete hands-on step"}]}',
    },
  ]);
  const parsed = parseJson(text);
  return parsed.weeks || [];
}

// ---------- UI ----------
export default function BookshelfCurriculumAgent() {
  const [photos, setPhotos] = useState([]); // {name, base64, previewUrl}
  const [projects, setProjects] = useState("");
  const [phase, setPhase] = useState("setup"); // setup | running | done | error
  const [log, setLog] = useState([]);
  const [results, setResults] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const fileRef = useRef(null);

  const addLog = (msg) => setLog((l) => [...l, msg]);

  const onFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    const next = [];
    for (const f of files) {
      try {
        const base64 = await fileToBase64Jpeg(f);
        next.push({ name: f.name, base64, previewUrl: URL.createObjectURL(f) });
      } catch {
        /* skip unreadable file */
      }
    }
    setPhotos((p) => [...p, ...next]);
    if (fileRef.current) fileRef.current.value = "";
  };

  const run = async () => {
    const projectList = projects
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!photos.length || !projectList.length) return;

    setPhase("running");
    setLog([]);
    setResults(null);
    try {
      // 1. Read spines
      let allBooks = [];
      for (let i = 0; i < photos.length; i++) {
        addLog(`Reading spines in photo ${i + 1} of ${photos.length}…`);
        const found = await extractTitles(photos[i].base64);
        allBooks = allBooks.concat(found);
      }
      // de-dupe by title
      const seen = new Set();
      allBooks = allBooks.filter((b) => {
        const k = (b.title || "").toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      addLog(`Found ${allBooks.length} titles.`);
      if (!allBooks.length) throw new Error("No readable titles found — try a closer, well-lit photo.");

      // 2. Sort by project
      addLog("Sorting titles into your project categories…");
      const sorted = await categorize(allBooks, projectList);
      const cats = (sorted.categories || []).filter((c) => c.books && c.books.length);

      // 3. Curriculum per category
      const finished = [];
      for (const cat of cats) {
        const weeks = scheduleFor(cat.books.length);
        addLog(`Designing a ${weeks}-week curriculum for “${cat.project}” (${cat.books.length} book${cat.books.length > 1 ? "s" : ""})…`);
        const plan = await buildCurriculum(cat.project, cat.books, weeks);
        finished.push({ ...cat, weeks, plan });
      }

      setResults({ categories: finished, unmatched: sorted.unmatched || [] });
      setPhase("done");
    } catch (err) {
      setErrorMsg(err.message || "Something went wrong.");
      setPhase("error");
    }
  };

  const reset = () => {
    setPhase("setup");
    setLog([]);
    setResults(null);
    setErrorMsg("");
  };

  const projectCount = projects.split(",").map((s) => s.trim()).filter(Boolean).length;
  const ready = photos.length > 0 && projectCount > 0;

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.ink, fontFamily: T.body, padding: "40px 20px" }}>
      <div style={{ maxWidth: 780, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ borderBottom: `3px double ${T.green}`, paddingBottom: 20, marginBottom: 28 }}>
          <div style={{ fontSize: 12, letterSpacing: "0.18em", textTransform: "uppercase", color: T.green, marginBottom: 6 }}>
            Personal Library · Study Plan
          </div>
          <h1 style={{ fontFamily: T.display, fontSize: 34, margin: 0, fontWeight: 600, lineHeight: 1.15 }}>
            Shelf to Syllabus
          </h1>
          <p style={{ color: T.muted, margin: "8px 0 0", fontSize: 15, maxWidth: 560 }}>
            Photograph your bookshelf, name your projects, and get a reading-and-practice curriculum built from books you already own.
          </p>
        </div>

        {phase === "setup" && (
          <div>
            {/* Step 1: photos */}
            <SectionLabel n="1" text="Add shelf photos" />
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                onFiles({ target: { files: e.dataTransfer.files } });
              }}
              style={{
                position: "relative",
                border: `1.5px dashed ${T.green}`,
                borderRadius: 10,
                padding: 28,
                textAlign: "center",
                background: T.card,
                marginBottom: 14,
              }}
            >
              <div style={{ fontFamily: T.display, fontSize: 17, color: T.greenDark }}>
                Tap to upload bookshelf photo(s)
              </div>
              <div style={{ fontSize: 13, color: T.muted, marginTop: 4 }}>
                Close-up, well-lit shots read best. Add one photo per shelf if needed. You can also drag photos here.
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                onChange={onFiles}
                aria-label="Upload bookshelf photos"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  opacity: 0,
                  cursor: "pointer",
                }}
              />
            </div>
            {photos.length > 0 && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
                {photos.map((p, i) => (
                  <div key={i} style={{ position: "relative" }}>
                    <img src={p.previewUrl} alt={p.name} style={{ width: 110, height: 82, objectFit: "cover", borderRadius: 6, border: `1px solid ${T.line}` }} />
                    <button
                      onClick={() => setPhotos((ph) => ph.filter((_, j) => j !== i))}
                      aria-label="Remove photo"
                      style={{ position: "absolute", top: -8, right: -8, width: 22, height: 22, borderRadius: "50%", border: "none", background: T.ink, color: "#fff", cursor: "pointer", fontSize: 12, lineHeight: "22px", padding: 0 }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Step 2: projects */}
            <SectionLabel n="2" text="Name your projects" />
            <input
              value={projects}
              onChange={(e) => setProjects(e.target.value)}
              placeholder="e.g. street safety advocacy, launching a newsletter, sourdough mastery"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "13px 15px",
                fontSize: 15,
                border: `1.5px solid ${T.line}`,
                borderRadius: 8,
                background: T.card,
                color: T.ink,
                outline: "none",
                marginBottom: 6,
                fontFamily: T.body,
              }}
            />
            <div style={{ fontSize: 13, color: T.muted, marginBottom: 26 }}>
              Separate with commas. Books get matched to whichever project fits best.
            </div>

            {/* Step 3: run */}
            <button
              onClick={run}
              disabled={!ready}
              style={{
                width: "100%",
                padding: "15px",
                fontSize: 16,
                fontFamily: T.display,
                fontWeight: 600,
                color: "#fff",
                background: ready ? T.green : "#B9C4B6",
                border: "none",
                borderRadius: 8,
                cursor: ready ? "pointer" : "default",
              }}
            >
              Build my curriculum
            </button>
            <div style={{ fontSize: 12.5, color: T.muted, marginTop: 10, textAlign: "center" }}>
              1 book in a category → 4 weeks · 2–3 books → 8 weeks · 4+ books → 12 weeks
            </div>
          </div>
        )}

        {phase === "running" && (
          <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 10, padding: 24 }}>
            <div style={{ fontFamily: T.display, fontSize: 19, marginBottom: 14, color: T.greenDark }}>
              The librarian is working…
            </div>
            {log.map((l, i) => (
              <div key={i} style={{ fontSize: 14, padding: "6px 0", color: i === log.length - 1 ? T.ink : T.muted, display: "flex", gap: 8 }}>
                <span style={{ color: T.marigold }}>{i === log.length - 1 ? "◐" : "✓"}</span>
                {l}
              </div>
            ))}
          </div>
        )}

        {phase === "error" && (
          <div style={{ background: "#FDF3F0", border: "1px solid #E8C4B8", borderRadius: 10, padding: 22 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>The agent hit a snag</div>
            <div style={{ fontSize: 14, color: T.muted, marginBottom: 16 }}>{errorMsg}</div>
            <button onClick={reset} style={btnSecondary()}>Start over</button>
          </div>
        )}

        {phase === "done" && results && (
          <div>
            {results.categories.length === 0 && (
              <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 10, padding: 22, marginBottom: 16, fontSize: 14 }}>
                None of the detected titles matched your project categories. Try broader project names or another shelf.
              </div>
            )}
            {results.categories.map((cat, i) => (
              <div key={i} style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 10, marginBottom: 22, overflow: "hidden" }}>
                {/* Catalog-card header */}
                <div style={{ padding: "18px 22px", borderBottom: `2px solid ${T.green}`, display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", color: T.muted }}>Project</div>
                    <div style={{ fontFamily: T.display, fontSize: 23, fontWeight: 600 }}>{cat.project}</div>
                  </div>
                  <div style={{ border: `2px solid ${T.marigold}`, color: "#9C731F", borderRadius: 6, padding: "4px 12px", fontSize: 13, fontWeight: 700, transform: "rotate(-2deg)", letterSpacing: "0.06em" }}>
                    {cat.weeks}-WEEK PLAN
                  </div>
                </div>
                <div style={{ padding: "14px 22px", borderBottom: `1px solid ${T.line}`, fontSize: 14 }}>
                  <span style={{ color: T.muted }}>From your shelf: </span>
                  <em style={{ fontFamily: T.display }}>{cat.books.join(" · ")}</em>
                </div>
                <div>
                  {cat.plan.map((w) => (
                    <div key={w.week} style={{ display: "flex", gap: 16, padding: "14px 22px", borderBottom: `1px solid ${T.line}` }}>
                      <div style={{ fontFamily: T.display, color: T.green, fontWeight: 700, minWidth: 52, fontSize: 15 }}>Wk {w.week}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 14.5 }}>{w.theme}</div>
                        <div style={{ fontSize: 13.5, color: T.ink, marginTop: 3 }}>{w.reading}</div>
                        <div style={{ fontSize: 13.5, color: T.muted, marginTop: 3 }}>
                          <span style={{ color: T.marigold, fontWeight: 700 }}>Practice: </span>
                          {w.practice}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {results.unmatched.length > 0 && (
              <div style={{ fontSize: 13.5, color: T.muted, marginBottom: 22 }}>
                <span style={{ fontWeight: 600 }}>On the shelf, off the syllabus: </span>
                {results.unmatched.join(" · ")}
              </div>
            )}

            <button onClick={reset} style={btnSecondary()}>Scan another shelf</button>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ n, text }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
      <span style={{ width: 24, height: 24, borderRadius: "50%", background: T.green, color: "#fff", fontSize: 13, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{n}</span>
      <span style={{ fontFamily: T.display, fontSize: 17, fontWeight: 600 }}>{text}</span>
    </div>
  );
}

function btnSecondary() {
  return {
    padding: "11px 20px",
    fontSize: 14.5,
    fontWeight: 600,
    color: T.greenDark,
    background: "transparent",
    border: `1.5px solid ${T.green}`,
    borderRadius: 8,
    cursor: "pointer",
    fontFamily: T.body,
  };
}
