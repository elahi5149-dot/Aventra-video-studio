(() => {
  const base = window.AVENTRA_API_BASE || "";
  const api = (path, options = {}) => window.aventraFetch
    ? window.aventraFetch(base + path, options)
    : fetch(base + path, options);

  document.addEventListener("DOMContentLoaded", () => {
    if (document.getElementById("aiSceneBuilderCard")) return;
    const card = document.createElement("section");
    card.id = "aiSceneBuilderCard";
    card.style.cssText = "margin:20px 0;padding:18px;border:1px solid #53618a;border-radius:14px;background:#111a30;color:#fff";
    card.innerHTML = `
      <h2>🎬 AI Scene Builder</h2>
      <p>Create a drama script, scene images and a voice-over video.</p>
      <label>Story Topic</label>
      <input id="sbTopic" placeholder="e.g. A family mystery in Pakistan" style="width:100%;padding:10px;margin:6px 0 12px">
      <label>Genre</label>
      <select id="sbGenre" style="width:100%;padding:10px;margin:6px 0 12px">
        <option>Pakistani Drama</option><option>Hollywood Action</option>
      </select>
      <label>Language</label>
      <select id="sbLanguage" style="width:100%;padding:10px;margin:6px 0 12px">
        <option>Urdu</option><option>English</option>
      </select>
      <label>Duration</label>
      <select id="sbDuration" style="width:100%;padding:10px;margin:6px 0 12px">
        <option value="1">1 minute</option>
        <option value="2">2 minutes</option>
        <option value="3">3 minutes</option>
      </select>
      <label>Saved Characters</label>
      <select id="sbCharacters" multiple size="4" style="width:100%;padding:10px;margin:6px 0 12px"></select>
      <button id="sbLoadCharacters" type="button">↻ Load Characters</button>
      <button id="sbGenerateScript" type="button">✍️ Generate Script</button>
      <textarea id="sbScript" rows="9" placeholder="Your generated script will appear here..." style="width:100%;box-sizing:border-box;padding:10px;margin:12px 0"></textarea>
      <button id="sbBuildVideo" type="button">🎥 Generate Scenes & Video</button>
      <p id="sbStatus" role="status">Ready.</p>
      <div id="sbGallery"></div>
      <video id="sbVideo" controls style="display:none;width:100%;margin-top:12px"></video>`;
    const anchor = document.querySelector("#youtubeAutomation") ||
      document.querySelector("#youtubeAutomationCard") ||
      document.querySelector("#dramaCharacterGallery") ||
      document.querySelector("main") ||
      document.body;
    anchor.appendChild(card);
  });
})();

(() => {
  const request = (path, options = {}) =>
    window.aventraFetch
      ? window.aventraFetch(path, options)
      : fetch(path, options);

  const json = data => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });

  document.addEventListener("DOMContentLoaded", () => {
    const el = id => document.getElementById(id);
    const status = el("sbStatus");
    if (!el("sbGenerateScript")) return;

    el("sbLoadCharacters").onclick = async () => {
      try {
        status.textContent = "Loading saved characters...";
        const r = await request("/api/drama/characters");
        const d = await r.json();
        if (!r.ok) throw Error(d.message || d.error || "Could not load characters");
        const list = d.characters || [];
        el("sbCharacters").innerHTML = "";
        list.forEach(c => {
          const o = document.createElement("option");
          o.value = c.id;
          o.textContent = c.name + (c.age ? " (" + c.age + ")" : "");
          el("sbCharacters").appendChild(o);
        });
        status.textContent = list.length
          ? "Loaded " + list.length + " saved characters."
          : "No saved characters found.";
      } catch (e) {
        status.textContent = "Error: " + e.message;
      }
    };

    el("sbGenerateScript").onclick = async () => {
      try {
        const topic = el("sbTopic").value.trim();
        if (!topic) return status.textContent = "Please enter a story topic.";
        status.textContent = "Generating script...";
        const ids = [...el("sbCharacters").selectedOptions].map(o => o.value);
        const chars = [...el("sbCharacters").selectedOptions].map(o => ({
          id: o.value, name: o.textContent
        }));
        const r = await request("/api/drama/script", json({
          topic,
          genre: el("sbGenre").value,
          language: el("sbLanguage").value,
          duration: parseInt(el("sbDuration").value, 10) || 1,
          characters: Math.min(4, Math.max(2, chars.length || 2)),
          selectedCharacters: chars
        }));
        const d = await r.json();
        if (!r.ok || !d.success) throw Error(d.message || d.error || "Script generation failed");
        el("sbScript").value = typeof d.script === "string"
          ? d.script : JSON.stringify(d.script, null, 2);
        status.textContent = "Script generated successfully.";
      } catch (e) {
        status.textContent = "Error: " + e.message;
      }
    };

    el("sbBuildVideo").onclick = () => {
      status.textContent =
        "Next step: connect scene image generation and video rendering.";
    };

    el("sbLoadCharacters").click();
  });
})();
